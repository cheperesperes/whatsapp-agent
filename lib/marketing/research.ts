import Anthropic from '@anthropic-ai/sdk';

interface SearchResult {
  title: string;
  snippet: string;
  link: string;
}

interface SerperResponse {
  organic?: SearchResult[];
  answerBox?: { answer?: string; snippet?: string };
}

// Trend search queries — split across the four customer use-cases Oiikon
// serves so Luz's daily brief reflects the full audience, not just Cuba.
//   1. Cuba / Hispanic diaspora — original core (apagones in Cuba/Venezuela)
//   2. RV & overlanding — US weekend / road-trip / boondocking buyers
//   3. US blackout & grid resilience — hurricane / wildfire / heatwave
//      preparedness in storm-prone states (FL, TX, LA, NC, CA, PR)
//   4. Energy-saving / off-grid living — homeowners cutting bills, cabins,
//      tiny-house, solar-curious. Grows year-round, not seasonal.
const TREND_QUERIES = [
  // Cuba / Hispanic diaspora
  'estacion solar portatil cuba venezuela apagon 2026',
  'PECRON solar power station review español hispanos',
  'apagon cuba venezuela haiti energia solar solucion familia',
  // RV & overlanding (English-speaking US buyers)
  'best portable power station for RV camping 2026',
  'boondocking solar generator overlanding lithium battery',
  // US blackout & hurricane prep
  'hurricane season 2026 power outage backup battery florida texas',
  'home backup power station blackout grid down preparedness',
  // Energy saving / off-grid
  'solar generator off grid cabin tiny house energy savings',
  'reduce electricity bill portable power station home backup',
];

const GROUP_QUERIES = [
  // Cuba / Hispanic diaspora — diaspora to Cuba/VE, Habana MIPYMES
  'site:facebook.com/groups cubanos exterior energia solar ayuda',
  'site:facebook.com/groups cuba apagon familia ayuda',
  'site:facebook.com/groups venezolanos exterior ayuda familia',
  'site:facebook.com/groups dominicanos puertorriquenos USA',
  'site:facebook.com/groups latinos miami florida hialeah',
  // RV / overlanding — broad US English-language audience
  'site:facebook.com/groups RV living full time boondockers',
  'site:facebook.com/groups overlanding camping solar power',
  'site:facebook.com/groups van life off grid power',
  // US blackout & hurricane prep — storm-prone state communities
  'site:facebook.com/groups hurricane preparedness florida texas louisiana',
  'site:facebook.com/groups power outage backup home generator',
  'site:facebook.com/groups storm prep coastal florida',
  // Energy saving / off-grid living
  'site:facebook.com/groups off grid living homestead solar',
  'site:facebook.com/groups tiny house solar power affordable',
  'site:facebook.com/groups energy independence reduce electric bill',
];

async function searchSerper(query: string, num = 5): Promise<SearchResult[]> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new Error('SERPER_API_KEY not set');

  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, hl: 'es', gl: 'us', num }),
  });

  if (!res.ok) throw new Error(`Serper error: ${res.status}`);
  const data = (await res.json()) as SerperResponse;
  return data.organic ?? [];
}

export interface ResearchResult {
  brief: string;
  facebookGroups: Array<{ name: string; url: string; description: string }>;
}

export async function conductDailyResearch(): Promise<ResearchResult> {
  // Run trend searches + group discovery in parallel
  const [trendResults, groupResults] = await Promise.all([
    Promise.allSettled(TREND_QUERIES.slice(0, 3).map((q) => searchSerper(q, 5))),
    Promise.allSettled(GROUP_QUERIES.map((q) => searchSerper(q, 5))),
  ]);

  // Aggregate trend snippets
  const snippets: string[] = [];
  trendResults.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      r.value.slice(0, 3).forEach((item) => {
        snippets.push(`[${TREND_QUERIES[i]}]\n${item.title}: ${item.snippet}`);
      });
    }
  });

  // Extract Facebook group candidates
  const rawGroups: SearchResult[] = [];
  groupResults.forEach((r) => {
    if (r.status === 'fulfilled') rawGroups.push(...r.value);
  });

  const facebookGroups = rawGroups
    .filter((r) => r.link.includes('facebook.com/groups'))
    .map((r) => ({
      name: r.title.replace(/\s*\|.*$/, '').trim(),
      url: r.link,
      description: r.snippet,
    }))
    .slice(0, 20); // top 20 groups found today

  // Claude synthesizes the research brief
  const anthropic = new Anthropic();
  let brief = snippets[0] ?? 'Tendencias no disponibles hoy.';

  if (snippets.length > 0) {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 350,
      messages: [
        {
          role: 'user',
          content: `Eres el estratega de marketing de Oiikon, tienda de estaciones solares portátiles PECRON. La audiencia tiene CUATRO segmentos:

1. Diáspora cubana/hispana en USA que envían equipos a familia en Cuba/Venezuela (apagones diarios de 8–20 h).
2. Compradores de RV / camping / overlanding en USA (boondocking, viajes, vida en furgoneta).
3. Hogares en estados con apagones por huracán, incendios o grid débil (FL, TX, LA, NC, CA, PR) — preparación ante tormentas y blackouts.
4. Familias buscando ahorrar en luz / vivir off-grid / cabaña / tiny house — independencia energética y reducción de factura.

Resultados de búsqueda de hoy:
${snippets.join('\n\n')}

En 4-6 oraciones en ESPAÑOL resume:
1. Tema/tendencia más relevante hoy y a CUÁL de los 4 segmentos golpea más fuerte.
2. Si aplica a Cuba/Venezuela: ángulo de apagones y familia. Si aplica a USA: ángulo de huracán/RV/ahorro/blackout.
3. Ángulo emocional o urgencia para la campaña de hoy. Si la oportunidad es bilingüe (Cuba + USA), sugiere cómo dividir el mensaje.

Solo el resumen, sin introducción.`,
        },
      ],
    });
    if (msg.content[0].type === 'text') brief = msg.content[0].text;
  }

  return { brief, facebookGroups };
}
