import gemini from './gemini.mjs';

const string = { type: 'string' };
const strings = { type: 'array', items: string };

function object(properties) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const formats = {
  dialogue: {
    schema: object({
      reply: string,
      history: {
        type: 'array',
        items: object({
          group: { type: 'string', enum: ['S', 'A', 'M', 'P', 'L', 'E'] },
          value: string,
        }),
      },
    }),
    tokens: 600,
  },
  commands: { schema: object({ ids: strings }), tokens: 384 },
  debrief: { schema: object({ report: string }), tokens: 3_000 },
  interaction: {
    schema: object({
      reply: string,
      seconds: { type: 'number' },
      actions: strings,
      intents: strings,
    }),
    tokens: 1_000,
  },
};

export default async function handler(request, response) {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    response.setHeader('X-Simulator-AI', 'gemini');
    return gemini(request, response);
  }

  response.setHeader('Cache-Control', 'no-store');
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    response.setHeader('X-Simulator-Revision', process.env.VERCEL_GIT_COMMIT_SHA);
  }
  response.setHeader('X-Simulator-AI', 'openai');

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'Použij metodu POST.' });
  }

  const { prompt, mode = 'interaction' } = request.body ?? {};
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 24_000 || !Object.hasOwn(formats, mode)) {
    return response.status(400).json({ error: 'Neplatný nebo příliš dlouhý požadavek.' });
  }

  const { schema, tokens } = formats[mode];
  const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini';
  const config = {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      store: false,
      instructions: 'Jsi součást českého fiktivního výukového simulátoru ZZS. ' +
        'Respektuj oddělení scénáře, stavových údajů a zprávy hráče. Použij požadovaný formát a odpověz česky.',
      input: prompt,
      max_output_tokens: tokens,
      text: { format: { type: 'json_schema', name: mode, schema, strict: true } },
    }),
  };

  try {
    let result;
    try {
      result = await fetch('https://api.openai.com/v1/responses', {
        ...config, signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      if (!['TimeoutError', 'AbortError', 'TypeError'].includes(error.name)) throw error;
    }
    if (!result || [408, 500, 502, 503, 504].includes(result.status)) {
      if (result) await result.body?.cancel().catch(() => {});
      result = await fetch('https://api.openai.com/v1/responses', {
        ...config, signal: AbortSignal.timeout(13_000),
      });
    }

    if (result.status === 401 || result.status === 403) {
      return response.status(502).json({ error: 'OpenAI odmítlo přístup. Zkontroluj OPENAI_API_KEY ve Vercelu.' });
    }
    if (result.status === 429) {
      const failure = await result.json().catch(() => null);
      if (failure?.error?.code === 'insufficient_quota' || failure?.error?.type === 'insufficient_quota') {
        return response.status(429).json({
          code: 'insufficient_quota',
          error: 'Projekt OpenAI nemá dostupnou kvótu. Zkontroluj fakturaci a kredit na platformě OpenAI.',
        });
      }
      return response.status(429).json({
        code: 'rate_limit',
        error: 'OpenAI dočasně omezilo počet požadavků. Zkus to za chvíli.',
      });
    }
    if (result.status === 404) {
      return response.status(502).json({ error: 'Nastavený model OpenAI není pro tento projekt dostupný.' });
    }
    if (!result.ok) {
      return response.status(502).json({ error: 'OpenAI odmítlo požadavek (HTTP ' + result.status + ').' });
    }

    const data = await result.json();
    const content = (data.output ?? []).flatMap(item => item.type === 'message' ? item.content ?? [] : []);
    if (content.some(part => part.type === 'refusal')) {
      return response.status(422).json({ error: 'AI tento vstup nezpracovala. Zkus konkrétnější formulaci ze scénáře.' });
    }
    const text = content.filter(part => part.type === 'output_text').map(part => part.text).join('');
    if (data.status !== 'completed' || !text) {
      return response.status(502).json({ error: 'OpenAI neposkytlo úplnou odpověď. Zkus požadavek znovu.' });
    }
    return response.status(200).json({ answer: JSON.parse(text) });
  } catch (error) {
    if (['TimeoutError', 'AbortError'].includes(error.name)) {
      return response.status(504).json({ error: 'OpenAI nestihlo odpovědět. Zkus požadavek znovu.' });
    }
    return response.status(502).json({ error: 'Spojení s OpenAI selhalo nebo odpověď nešla přečíst.' });
  }
}
