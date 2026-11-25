const dialogueConfig = {
  maxOutputTokens: 512,
  thinkingConfig: { thinkingLevel: 'MINIMAL' },
  responseSchema: {
    type: 'OBJECT',
    properties: {
      reply: { type: 'STRING' },
      history: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            group: { type: 'STRING', enum: ['S', 'A', 'M', 'P', 'L', 'E'] },
            value: { type: 'STRING' },
          },
          required: ['group', 'value'],
        },
      },
    },
    required: ['reply', 'history'],
  },
};

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'Použij metodu POST.' });
  }

  const secret = process.env.GEMINI_API_KEY?.trim();
  if (!secret) {
    return response.status(503).json({ error: 'Gemini ještě není nastavené na serveru.' });
  }

  const prompt = request.body?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 24_000) {
    return response.status(400).json({ error: 'Neplatný nebo příliš dlouhý požadavek.' });
  }

  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3.1-flash-lite';
  const dialogue = request.body?.mode === 'dialogue';
  const commands = request.body?.mode === 'commands';
  const commandSchema = {
    type: 'OBJECT',
    properties: { ids: { type: 'ARRAY', items: { type: 'STRING' } } },
    required: ['ids'],
  };
  const { thinkingConfig, ...dialogueSchema } = dialogueConfig;
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
            ...(dialogue ? dialogueSchema : {}),
            ...(commands ? { responseSchema: commandSchema, maxOutputTokens: 256 } : {}),
            ...((dialogue || commands) && model === 'gemini-3.1-flash-lite' ? { thinkingConfig } : {}),
          },
        }),
        signal: AbortSignal.timeout(25_000),
      }
    );
    if (result.status === 429) {
      return response.status(429).json({ error: 'Gemini vyčerpalo limit. Zkus to později.' });
    }
    if (!result.ok) {
      const failure = await result.json().catch(() => null);
      const details = failure?.error?.details;
      const reason = Array.isArray(details) ? details.find(detail =>
        detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo'
      )?.reason : undefined;
      if (['API_KEY_INVALID', 'API_KEY_EXPIRED'].includes(reason) || result.status === 401) {
        return response.status(502).json({ error: 'Google odmítl klíč Gemini. Ve Vercelu aktualizuj GEMINI_API_KEY a nasaď projekt znovu.' });
      }
      if (result.status === 403) {
        return response.status(502).json({ error: 'Google zamítl přístup ke Gemini. Zkontroluj, že klíč má povolený přístup ke Gemini API.' });
      }
      if (result.status === 404) {
        return response.status(502).json({ error: 'Nastavený model Gemini není dostupný. Zkontroluj GEMINI_MODEL ve Vercelu.' });
      }
      if (failure?.error?.message?.toLowerCase().includes('location is not supported')) {
        return response.status(502).json({ error: 'Gemini API v oblasti serveru Vercelu není dostupné.' });
      }
      return response.status(502).json({ error: 'Gemini odmítlo požadavek (HTTP ' + result.status + ').' });
    }

    const data = await result.json();
    const text = data.candidates?.[0]?.content?.parts
      ?.filter(part => !part.thought).map(part => part.text || '').join('');
    if (!text) {
      return response.status(502).json({ error: 'Gemini nevrátilo odpověď.' });
    }
    let answer;
    try {
      answer = JSON.parse(text);
    } catch {
      return response.status(502).json({ error: 'Gemini vrátilo odpověď v nečitelném formátu. Zkus zprávu odeslat znovu.' });
    }
    return response.status(200).json({ answer });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return response.status(504).json({ error: 'Gemini nestihlo odpovědět. Zkus zprávu odeslat znovu.' });
    }
    return response.status(502).json({ error: 'Spojení s Gemini selhalo. Zkus zprávu odeslat znovu.' });
  }
}
