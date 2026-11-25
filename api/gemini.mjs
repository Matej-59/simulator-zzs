export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'Použij metodu POST.' });
  }

  const secret = process.env.GEMINI_API_KEY;
  if (!secret) {
    return response.status(503).json({ error: 'Gemini ještě není nastavené na serveru.' });
  }

  const prompt = request.body?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 24_000) {
    return response.status(400).json({ error: 'Neplatný nebo příliš dlouhý požadavek.' });
  }

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  try {
    const result = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(model) + ':generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': secret },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.2,
            maxOutputTokens: 4096,
          },
        }),
        signal: AbortSignal.timeout(25_000),
      }
    );
    if (result.status === 429) {
      return response.status(429).json({ error: 'Gemini vyčerpalo limit. Zkus to později.' });
    }
    if (!result.ok) {
      return response.status(502).json({ error: 'Gemini odmítlo požadavek. Zkontroluj nastavení služby.' });
    }

    const data = await result.json();
    const text = data.candidates?.[0]?.content?.parts
      ?.filter(part => !part.thought).map(part => part.text || '').join('');
    if (!text) {
      return response.status(502).json({ error: 'Gemini nevrátilo odpověď.' });
    }
    return response.status(200).json({ answer: JSON.parse(text) });
  } catch {
    return response.status(502).json({ error: 'Gemini neposkytlo platnou odpověď včas.' });
  }
}
