// This file contains functions to interact with Firestore.
// It is used by the main chatbot function.

// Import Firebase Admin SDK to interact with Firestore securely on the server side
const admin = require('firebase-admin');

// We need to initialize the Firebase app. The credentials are provided via Netlify's environment variables.
// It's a bit different from client-side setup. We get the config as a JSON string.
// You will need to add a FIREBASE_CONFIG environment variable in Netlify.
// Example: '{"type": "service_account", "project_id": "...", "private_key_id": "...", ...}'
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

/**
 * Saves a new message pair (user message and bot reply) to a conversation history.
 * @param {string} sessionId The unique session ID for the conversation.
 * @param {string} userMessage The user's message.
 * @param {string} botReply The bot's reply.
 */
async function saveHistory(sessionId, userMessage, botReply) {
    const docRef = db.collection('chat_history').doc(sessionId);
    
    // Use a transaction to safely get and update the document
    return db.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);

        const newEntry = {
            user: userMessage,
            bot: botReply
        };

        if (!doc.exists) {
            // If the document doesn't exist, create it with the first message
            // Note: We use a simple timestamp here because serverTimestamp() isn't allowed in an array during a set operation.
            newEntry.timestamp = admin.firestore.Timestamp.now();
            transaction.set(docRef, {
                messages: [newEntry]
            });
        } else {
            // If it exists, append the new message to the existing array.
            // Using arrayUnion ensures we add to the array atomically without overwriting it.
            newEntry.timestamp = admin.firestore.FieldValue.serverTimestamp();
            transaction.update(docRef, { 
                messages: admin.firestore.FieldValue.arrayUnion(newEntry)
            });
        }
    });
}

/**
 * Retrieves the chat history for a given session ID.
 * @param {string} sessionId The unique session ID.
 * @returns {Array} An array of messages from the conversation.
 */
async function getHistory(sessionId) {
    const docRef = db.collection('chat_history').doc(sessionId);
    const doc = await docRef.get();
    
    if (doc.exists) {
        return doc.data().messages;
    } else {
        return [];
    }
}

module.exports = {
    saveHistory,
    getHistory
};
