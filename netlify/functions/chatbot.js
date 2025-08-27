// netlify/functions/chatbot.js
// In-memory RAG with Gemini (no Firestore)

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Google Generative Language API endpoints
const GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;
const EMBED_URL    = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GEMINI_API_KEY}`;

// Bundle /documents with the function (via netlify.toml included_files)
const DOCS_DIR = path.resolve(__dirname, '../../documents');

// Module-level memory (persists while the lambda stays warm)
const store = {
  ingested: false,
  vectors: [],           // { embedding: number[], text: string, source: string }
  history: new Map(),    // sessionId -> [{ role: 'user'|'bot', text }]
};

const SYSTEM_PROMPT = `You are a concise, helpful assistant for Teja Vishnu Vardhan Boddu.
Use CONTEXT snippets to answer. If context is insufficient, state that briefly and proceed with your best answer.
When using a snippet, lightly cite it like [filename].`;

// ---------- helpers ----------
function chunkText(text, size = 1000, overlap = 200) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + size, text.length);
    chunks.push(text.slice(i, end));
    i += size - overlap;
  }
  return chunks.map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

async function embedRaw(text, taskType = 'RETRIEVAL_DOCUMENT') {
  const body = {
    model: 'models/text-embedding-004',
    content: { parts: [{ text }] },
    taskType,
  };
  const res = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embeddings API error ${res.status}: ${err}`);
  }
  const json = await res.json();
  const vec = json?.embedding?.values || json?.embedding?.value || [];
  if (!Array.isArray(vec) || vec.length === 0) throw new Error('Empty embedding vector');
  return vec.map(Number);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]; const y = b[i];
    dot += x * y; na += x * x; nb += y * y;
  }
  return (na && nb) ? (dot / (Math.sqrt(na) * Math.sqrt(nb))) : 0;
}

// ---------- ingestion (wrap all awaits INSIDE this function) ----------
async function ensureIngested() {
  if (store.ingested) return;

  if (!fs.existsSync(DOCS_DIR)) {
    store.ingested = true;
    return;
  }

  const files = fs.readdirSync(DOCS_DIR).filter(f => /\.(pdf|txt)$/i.test(f));

  for (const file of files) {
    const full = path.join(DOCS_DIR, file);
    let text = '';

    if (/\.pdf$/i.test(file)) {
      const data = await pdfParse(fs.readFileSync(full));
      text = (data.text || '').trim();
    } else {
      text = fs.readFileSync(full, 'utf8');
    }
    if (!text) continue;

    const chunks = chunkText(text);
    for (const chunk of chunks) {
      const embedding = await embedRaw(chunk, 'RETRIEVAL_DOCUMENT');
      store.vectors.push({ embedding, text: chunk, source: file });
    }
  }

  store.ingested = true;
}

async function retrieveTopK(query, k = 5) {
  if (!store.ingested) await ensureIngested();
  if (store.vectors.length === 0) return [];
  const q = await embedRaw(query, 'RETRIEVAL_QUERY');
  const scored = store.vectors.map(v => ({ ...v, score: cosine(q, v.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

async function generateWithContext(message, sessionId) {
  const top = await retrieveTopK(message, 5);
  const context = top.map(t => `[${t.source}] ${t.text}`).join('\n---\n');

  const turns = store.history.get(sessionId) || [];
  const historyText = turns
    .slice(-10)
    .map(t => `${t.role === 'user' ? 'User' : 'Bot'}: ${t.text}`)
    .join('\n');

  const prompt = `SYSTEM:\n${SYSTEM_PROMPT}\n\nCONTEXT:\n${context || '(no context)'}\n\nHISTORY:\n${historyText || '(none)'}\n\nUSER:\n${message}`;

  const payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };

  const res = await fetch(GENERATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini generate error ${res.status}: ${err}`);
  }

  const json = await res.json();
  const reply = (json?.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || '')
    .join('')
    .trim() || 'No reply.';

  // Update in-memory history (bounded)
  const updated = [...turns, { role: 'user', text: message }, { role: 'bot', text: reply }];
  const MAX_TURNS = 40;
  store.history.set(sessionId, updated.slice(-MAX_TURNS));

  return reply;
}

// ---------- Netlify function handler ----------
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }
    if (!GEMINI_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Missing GEMINI_API_KEY' }) };
    }

    const { message, sessionId } = JSON.parse(event.body || '{}');
    if (!message || !sessionId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing message or sessionId' }) };
    }

    await ensureIngested();
    const reply = await generateWithContext(message, sessionId);

    return { statusCode: 200, body: JSON.stringify({ reply }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to process request.' }) };
  }
};
