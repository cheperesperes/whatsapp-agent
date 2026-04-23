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

const TREND_QUERIES = [
  'estacion solar portatil cuba venezuela apagon 2025',
  'PECRON solar power station review español hispanos',
  'energia solar crisis electrica familias latinoamerica',
  'portable power station hispanos latinos USA regalo familia',
  'apagon cuba venezuela haiti energia solar solucion',
];

const GROUP_QUERIES = [
  'site:facebook.com/groups cubanos exterior energia solar ayuda',
  'site:facebook.com/groups cuba apagon familia ayuda',
  'site:facebook.com/groups hispanos latinos USA comunidad florida',
  'site:facebook.com/groups venezolanos exterior ayuda familia',
  'site:facebook.com/groups mexicanos americanos comunidad',
  'site:facebook.com/groups puertorriquenos diaspora comunidad',
  'site:facebook.com/groups dominicanos USA exterior',
  'site:facebook.com/groups latinos miami solar energia',
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
          content: `Eres el estratega de marketing de Oiikon, tienda de estaciones solares portátiles PECRON para cubano-americanos que envían a Cuba (apagones 8-20h diarias).

Resultados de búsqueda de hoy:
${snippets.join('\n\n')}

En 3-4 oraciones en ESPAÑOL resume:
1. Tema/tendencia más relevante hoy para nuestra audiencia
2. Conexión con el problema de apagones en Cuba
3. Ángulo emocional o urgencia para la campaña de hoy

Solo el resumen, sin introducción.`,
        },
      ],
    });
    if (msg.content[0].type === 'text') brief = msg.content[0].text;
  }

  return { brief, facebookGroups };
}
