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
            bot: botReply,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
        
        // This is the correct way to handle the array update to avoid the Firestore error.
        // We get the existing messages, add the new one, and then set the entire array.
        if (!doc.exists) {
            transaction.set(docRef, {
                messages: [newEntry]
            });
        } else {
            const messages = doc.data().messages || [];
            messages.push(newEntry);
            transaction.update(docRef, { messages: messages });
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
