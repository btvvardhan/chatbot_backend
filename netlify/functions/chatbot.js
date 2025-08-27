// This is your Netlify serverless function. It securely calls the Gemini API.

// We use the Gemini API from Google for text generation.
// IMPORTANT: The API key is stored in Netlify's environment variables.
// It is NOT hardcoded here to keep it secure.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// API URL for Gemini's text generation model
const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=" + GEMINI_API_KEY;

// Import the Firestore helper functions we created
const { getHistory, saveHistory } = require('./firestore');

// The main handler for the serverless function
exports.handler = async function(event, context) {
  // Only allow POST requests
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: "Method Not Allowed"
    };
  }

  // Check if API key is set
  if (!GEMINI_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "API key is not configured." })
    };
  }

  try {
    const { message, sessionId } = JSON.parse(event.body);

    // Get the previous chat history from Firestore
    let history = await getHistory(sessionId);

    // Combine previous history and the new message to create a conversational prompt
    let chatHistory = "Previous conversation:\n";
    if (history && history.length > 0) {
      history.forEach(entry => {
        chatHistory += `User: ${entry.user}\nBot: ${entry.bot}\n`;
      });
    } else {
      chatHistory += "No previous history.\n";
    }
    chatHistory += `User: ${message}`;

    // This is the payload sent to the Gemini API
    const payload = {
      contents: [{
        parts: [{ text: chatHistory }]
      }]
    };

    // Make the API call to Gemini
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
        // Log the error response for debugging
        const errorText = await response.text();
        console.error("Gemini API Error:", response.status, errorText);
        throw new Error(`Gemini API returned an error: ${response.status}`);
    }

    const result = await response.json();
    
    // Extract the text from the Gemini response
    const botReply = result?.candidates?.[0]?.content?.parts?.[0]?.text || "No reply from the bot.";

    // Save the user's message and the bot's reply to the database
    await saveHistory(sessionId, message, botReply);

    return {
      statusCode: 200,
      body: JSON.stringify({ reply: botReply })
    };

  } catch (error) {
    console.error("Function Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to process the request." })
    };
  }
};
