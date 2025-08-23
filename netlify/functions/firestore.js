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
    
    // We get the document first to check if it exists
    const doc = await docRef.get();

    const newEntry = {
        user: userMessage,
        bot: botReply,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    
    // Check if the document exists to determine whether to set or update
    if (!doc.exists) {
        // If the document doesn't exist, create it with the first message.
        // The transaction is handled by the set operation implicitly.
        await docRef.set({
            messages: [newEntry]
        });
    } else {
        // If it exists, update it by atomically adding the new entry to the messages array.
        // This is the correct use of FieldValue.arrayUnion() with serverTimestamp().
        await docRef.update({
            messages: admin.firestore.FieldValue.arrayUnion(newEntry)
        });
    }
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
