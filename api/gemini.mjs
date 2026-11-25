const dialogueConfig = {
  maxOutputTokens: 512,
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

async function generate(model, key, prompt, config, timeout) {
  return fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) + ':generateContent',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          ...config,
          ...(model.startsWith('gemini-3') && config.responseSchema
            ? { thinkingConfig: { thinkingLevel: 'MINIMAL' } } : {}),
        },
      }),
      signal: AbortSignal.timeout(timeout),
    }
  );
}

function retryable(error) {
  return ['TypeError', 'TimeoutError', 'AbortError'].includes(error?.name);
}

async function readAnswer(result, mode) {
  const data = await result.json().catch(error => {
    if (error instanceof SyntaxError) return null;
    throw error;
  });
  const text = data?.candidates?.[0]?.content?.parts
    ?.filter(part => !part.thought).map(part => part.text || '').join('').trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text.replace(/^```(?:json)?\s*([\s\S]+?)\s*```$/i, '$1'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (mode === 'dialogue' && (typeof value.reply !== 'string' || !value.reply.trim())) return null;
    if (mode === 'commands' && !Array.isArray(value.ids)) return null;
    return value;
  } catch {
    return null;
  }
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Simulator-AI', 'gemini');
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    response.setHeader('X-Simulator-Revision', process.env.VERCEL_GIT_COMMIT_SHA);
  }

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'Použij metodu POST.' });
  }

  // Gemini generation requests cannot specify a billing tier.
  if (process.env.GEMINI_FREE_TIER_CONFIRMED !== 'true') {
    return response.status(503).json({
      code: 'gemini_free_tier_unconfirmed',
      error: 'Gemini čeká na potvrzení bezplatného projektu. Základní simulace zůstává dostupná.',
    });
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
  const mode = request.body?.mode;
  const dialogue = mode === 'dialogue';
  const commands = mode === 'commands';
  const commandSchema = {
    type: 'OBJECT',
    properties: { ids: { type: 'ARRAY', items: { type: 'STRING' } } },
    required: ['ids'],
  };
  const config = {
    responseMimeType: 'application/json',
    temperature: 0.2,
    maxOutputTokens: 4096,
    ...(dialogue ? dialogueConfig : {}),
    ...(commands ? { responseSchema: commandSchema, maxOutputTokens: 512 } : {}),
  };
  const fallbackModel = process.env.GEMINI_FALLBACK_MODEL?.trim() || model;
  try {
    let result, answer;
    try {
      result = await generate(model, secret, prompt, config, 9_000);
      if (result.ok) answer = await readAnswer(result, mode);
    } catch (error) {
      if (!retryable(error)) throw error;
    }
    if (!result || (result.ok && !answer) || [408, 500, 502, 503, 504].includes(result.status)) {
      if (result && !result.bodyUsed) await result.body?.cancel().catch(() => {});
      result = await generate(fallbackModel, secret, prompt, config, 13_000);
      if (result.ok) answer = await readAnswer(result, mode);
    }
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
      if (result.status >= 500) {
        return response.status(503).json({ error: 'Gemini je dočasně nedostupné. Zkus příkaz odeslat znovu.' });
      }
      return response.status(502).json({ error: 'Gemini odmítlo požadavek (HTTP ' + result.status + ').' });
    }

    if (!answer) {
      return response.status(502).json({ error: 'Gemini nevrátilo čitelnou odpověď. Zkus zprávu odeslat znovu.' });
    }
    return response.status(200).json({ answer });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return response.status(504).json({ error: 'Gemini nestihlo odpovědět. Zkus zprávu odeslat znovu.' });
    }
    return response.status(502).json({ error: 'Spojení s Gemini selhalo. Zkus zprávu odeslat znovu.' });
  }
}
