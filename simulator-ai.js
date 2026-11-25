(() => {
  const library = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.79/lib/index.js';
  const model = 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC';
  const commands = Object.freeze({
    scene: 'kontroluji bezpečnost',
    bleeding: 'vyšetřuji krvácení',
    airway: 'vyšetřuji dýchací cesty',
    chest: 'auskultace hrudníku',
    circulation: 'kontroluji pulz',
    pressure: 'měřím krevní tlak',
    saturation: 'měřím saturaci',
    breaths: 'měřím dechovou frekvenci',
    monitor: 'připojím EKG monitor',
    neurological: 'vyšetřuji GCS',
    exposure: 'celkové vyšetření',
    history: 'zjišťuji anamnézu',
    reevaluate: 'reevaluace',
    helicopter: 'žádám LZS',
    doctor: 'žádám RV',
  });
  let engine;

  async function load(progress) {
    if (!navigator.gpu) throw new Error('WebGPU není dostupné.');
    const { CreateWebWorkerMLCEngine } = await import(library);
    const worker = new Worker(new URL('./ai-worker.js', document.baseURI), { type: 'module' });
    try {
      engine = await CreateWebWorkerMLCEngine(worker, model, { initProgressCallback: progress });
    } catch (error) {
      worker.terminate();
      throw error;
    }
  }

  async function reply(instructions, input, maxTokens, json = false) {
    const result = await engine.chat.completions.create({
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: JSON.stringify(input) },
      ],
      max_tokens: maxTokens,
      temperature: 0,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    });
    const answer = result.choices[0]?.message?.content?.trim();
    if (!answer) throw new Error('Model nevrátil odpověď.');
    return answer;
  }

  async function interpret(text) {
    const answer = await reply(
      'Rozpoznej explicitní prováděné úkony ve výukové simulaci v češtině. ' +
      'Vrať výhradně JSON {"actions":["id"]} v pořadí provedení. Pokud je některý úkon nejasný, ' +
      'není v nabídce, je negovaný, je v otázce nebo jen plánovaný, vrať {"actions":[]}. ' +
      'Žádný úkon nepřidávej a neměň pořadí.',
      { nabídka: commands, vstup: text }, 120, true
    );
    const { actions } = JSON.parse(answer);
    if (!Array.isArray(actions) || actions.length > 8 ||
        actions.some(id => typeof id !== 'string' || !Object.hasOwn(commands, id))) {
      throw new Error('Neplatný seznam úkonů.');
    }
    return actions.map(id => commands[id]);
  }

  function dialogue(role, facts, question) {
    return reply(
      'Hraješ uvedenou roli v české simulaci výjezdu. Odpověz česky, nejvýše dvěma krátkými větami. ' +
      'Použij výhradně dodaná fakta. Pokud odpověď neznáš, řekni to. Nevymýšlej výsledky, úkony, ' +
      'diagnózy ani časy. Nedávej zdravotnické pokyny. Požadavek na změnu situace pouze odkaž na režim úkonů.',
      { role, fakta: facts, dotaz: question }, 100
    );
  }

  function debrief(events, handover) {
    return reply(
      'V češtině stručně shrň zaznamenané kroky výukové simulace v časovém pořadí. ' +
      'Přidej dvě otevřené otázky k diskusi s instruktorem o pořadí úkonů nebo úplnosti předání. ' +
      'Pracuj pouze s dodanými údaji. Nedávej klinická doporučení, nehodnoť dávky a nevymýšlej provedené úkony.',
      { kroky: events, předání: handover }, 260
    );
  }

  window.simulatorAI = { load, interpret, dialogue, debrief };
})();
