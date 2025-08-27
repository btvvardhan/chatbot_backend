// This is your Netlify serverless function for RAG.

// --- Core Dependencies ---
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
// Use dynamic import for ES Modules in a CommonJS environment
const { pipeline } = await import('@xenova/transformers');
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");

// --- Gemini API Configuration ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=" + GEMINI_API_KEY;

// --- System Prompt ---
// This guides the AI's behavior.
const systemPrompt = `You are an expert Q&A assistant. Your goal is to answer questions as accurately as possible based on the provided context.
- Read the context carefully before answering.
- If the context does not contain the answer, state that you don't have enough information.
- Do not make up information or use external knowledge.`;

// --- RAG Pipeline - In-Memory Storage & Logic ---

// 1. Singleton to ensure we only load the embedding model once per instance.
class EmbeddingPipelineSingleton {
    static task = 'feature-extraction';
    static model = 'Xenova/all-MiniLM-L6-v2'; // A good, small embedding model
    static instance = null;

    static async getInstance() {
        if (this.instance === null) {
            this.instance = await pipeline(this.task, this.model);
        }
        return this.instance;
    }
}

// 2. In-memory vector store. This is populated once when the function starts.
let vectorStore = null;

// 3. Initialization function to load, chunk, and embed documents.
async function initializeVectorStore() {
    if (vectorStore) return; // Already initialized
    console.log("Initializing vector store...");

    const docFolderPath = path.join(__dirname, '../../doc');
    const documents = [];

    // Read files from the /doc folder
    const files = fs.readdirSync(docFolderPath);
    for (const file of files) {
        const filePath = path.join(docFolderPath, file);
        let text = '';
        if (file.endsWith('.txt')) {
            text = fs.readFileSync(filePath, 'utf-8');
        } else if (file.endsWith('.pdf')) {
            const dataBuffer = fs.readFileSync(filePath);
            const pdfData = await pdf(dataBuffer);
            text = pdfData.text;
        }
        documents.push(text);
    }
    
    // Split documents into smaller chunks
    const textSplitter = new RecursiveCharacterTextSplitter({
        chunkSize: 500,
        chunkOverlap: 50
    });
    const chunks = await textSplitter.splitText(documents.join('\n\n'));

    // Create embeddings for each chunk
    const extractor = await EmbeddingPipelineSingleton.getInstance();
    const outputs = await extractor(chunks, { pooling: 'mean', normalize: true });

    // Store the text chunk along with its vector embedding
    vectorStore = outputs.tolist().map((vector, i) => ({
        text: chunks[i],
        embedding: vector,
    }));
    console.log(`Vector store initialized with ${vectorStore.length} chunks.`);
}

// 4. Cosine similarity function to find the most relevant document chunks.
function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// --- Main Serverless Function Handler ---
exports.handler = async function(event) {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }
    if (!GEMINI_API_KEY) {
        return { statusCode: 500, body: JSON.stringify({ error: "API key is not configured." }) };
    }

    try {
        // Ensure vector store is ready before processing the request
        await initializeVectorStore();

        const { message } = JSON.parse(event.body);

        // --- Retrieval Step ---
        const extractor = await EmbeddingPipelineSingleton.getInstance();
        const queryEmbedding = await extractor(message, { pooling: 'mean', normalize: true });

        // Find the top 3 most relevant document chunks
        const similarities = vectorStore.map(doc => ({
            text: doc.text,
            similarity: cosineSimilarity(queryEmbedding.data, doc.embedding)
        }));

        similarities.sort((a, b) => b.similarity - a.similarity);
        const topContext = similarities.slice(0, 3).map(item => item.text).join('\n\n---\n\n');

        // --- Augmentation & Generation Step ---
        const userPrompt = `Context:\n${topContext}\n\nQuestion: ${message}`;

        const payload = {
            contents: [{ parts: [{ text: userPrompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] }
        };

        const response = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("Gemini API Error:", response.status, errorText);
            throw new Error(`Gemini API returned an error: ${response.status}`);
        }

        const result = await response.json();
        const botReply = result?.candidates?.[0]?.content?.parts?.[0]?.text || "I couldn't generate a response.";

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