// netlify/functions/chatbot.js
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
.slice(-10) // last few turns to keep prompt compact
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


// Update in‑memory history
const updated = [...turns, { role: 'user', text: message }, { role: 'bot', text: reply }];
// keep bounded
const MAX_TURNS = 40;
store.history.set(sessionId, updated.slice(-MAX_TURNS));


return reply;
}


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