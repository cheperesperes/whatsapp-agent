import Anthropic from '@anthropic-ai/sdk';

export interface GeneratedContent {
  daily_theme: string;
  product_sku: string;
  facebook_post: string;
  instagram_caption: string;
  google_ad_headlines: string[]; // 3 headlines, max 30 chars each
  google_ad_descriptions: string[]; // 2 descriptions, max 90 chars each
  youtube_title: string;
  youtube_script: string; // 150-200 words, 60-90 sec at normal pace
  youtube_description: string;
  youtube_tags: string[];
}

interface Product {
  sku: string;
  name: string;
  category: string;
  battery_capacity_wh?: number | null;
  battery_capacity_ah?: number | null;
  output_watts?: number | null;
  sell_price?: number | null;
  original_price?: number | null;
  discount_percentage?: number | null;
  cuba_total_price?: number | null;
  ideal_for?: string | null;
}

function pickDailyProduct(products: Product[]): Product {
  const inStock = products.filter((p) => p.sku);
  if (inStock.length === 0) return products[0];
  // Rotate by day-of-year so each day features a different product
  const dayOfYear = Math.floor(Date.now() / 86400000);
  return inStock[dayOfYear % inStock.length];
}

export type MarketingCategory =
  | 'educacion'
  | 'tips'
  | 'instalacion'
  | 'baterias'
  | 'apagones'
  | 'familia'
  | 'producto';

export const CATEGORIES: Array<{ value: MarketingCategory; label: string; angle: string }> = [
  { value: 'producto', label: '🔌 Producto', angle: 'Destaca un producto específico (specs, precio, beneficio concreto).' },
  { value: 'educacion', label: '📚 Educación', angle: 'Educa sobre energía solar básica — qué es Wh, cómo funciona, por qué LiFePO4. Informativo, no vendedor.' },
  { value: 'tips', label: '💡 Tips', angle: 'Consejos prácticos: cómo ahorrar energía, qué cargar primero en apagón, mantenimiento del equipo.' },
  { value: 'instalacion', label: '🔧 Instalación', angle: 'Cómo conectar paneles, cómo recargar con solar, montaje en hogar. Práctico pero sin riesgo eléctrico.' },
  { value: 'baterias', label: '🔋 Baterías', angle: 'Foco en la batería LiFePO4: ciclos de vida, seguridad vs baterías de plomo, expansión con EP3800.' },
  { value: 'apagones', label: '⚡ Apagones', angle: 'Contexto emocional del apagón en Cuba: cómo preparar a la familia, qué mantener funcionando.' },
  { value: 'familia', label: '👨‍👩‍👧 Familia', angle: 'Historia humana — cómo la energía impacta la vida diaria de la familia en Cuba: nevera, estudios de niños, comunicación.' },
];

export async function generateMarketingContent(
  researchBrief: string,
  products: Product[],
  category?: MarketingCategory | null
): Promise<GeneratedContent> {
  const product = pickDailyProduct(products);
  const categoryEntry = category ? CATEGORIES.find((c) => c.value === category) : null;
  const categoryBrief = categoryEntry
    ? `\nCATEGORÍA DE HOY: ${categoryEntry.label}\nÁngulo específico: ${categoryEntry.angle}\n`
    : '';
  const sellPrice = Number(product.sell_price ?? 0);
  const originalPrice = Number(product.original_price ?? 0);
  const discount = Number(product.discount_percentage ?? 0);
  const cubaTotal = Number(product.cuba_total_price ?? 0);

  const specs: string[] = [];
  if (product.battery_capacity_wh) specs.push(`${product.battery_capacity_wh} Wh`);
  if (product.battery_capacity_ah) specs.push(`${product.battery_capacity_ah} Ah`);
  if (product.output_watts) specs.push(`${product.output_watts} W salida`);

  const priceLines: string[] = [];
  if (sellPrice > 0) priceLines.push(`  • Precio USA: $${sellPrice.toFixed(2)}`);
  if (originalPrice > 0 && discount > 0) {
    priceLines.push(`  • Antes: $${originalPrice.toFixed(2)} (${discount}% descuento activo)`);
  }
  if (cubaTotal > 0) priceLines.push(`  • Precio total entregado en Cuba: $${cubaTotal.toFixed(2)} (incluye envío + aduana)`);
  const pricesBlock = priceLines.length > 0 ? priceLines.join('\n') : '  • Precio: consultar en tienda';

  const anthropic = new Anthropic();

  const prompt = `Eres el director de marketing de Oiikon (oiikon.com), tienda especializada en estaciones solares portátiles para hispanos en EE.UU. que envían equipos a familiares en países con apagones prolongados.

PRODUCTO DEL DÍA (ÚNICOS DATOS PERMITIDOS — no inventes otros):
- Nombre: ${product.name}
- SKU: ${product.sku}
- Especificaciones: ${specs.length > 0 ? specs.join(', ') : 'no publicadas'}
${pricesBlock}
- Ideal para: ${product.ideal_for ?? 'no especificado'}
- URL: https://oiikon.com/product/${product.sku.toLowerCase()}

INVESTIGACIÓN DE HOY:
${researchBrief}
${categoryBrief}
AUDIENCIA PRINCIPAL:
Hispanos en EE.UU. (Miami, Tampa, Houston, NY, NJ, LA) con familia en países afectados por apagones. Motivación: amor familiar, solidaridad, solución práctica.

═══════════════════════════════════════════════════════════════════════════════
CÓDIGO DE CONDUCTA DE IA — OIIKON LLC (Marketing — Luz)
Las reglas abajo son OBLIGATORIAS y no admiten excepción. Si una regla y el
brief de investigación entran en conflicto, GANA LA REGLA.
═══════════════════════════════════════════════════════════════════════════════

§3.1 CUMPLIMIENTO LEGAL (MÁXIMA PRIORIDAD)
• Nunca prometas elegibilidad de envío a Cuba sin revisión humana.
• Nunca sugieras, impliques ni insinúes formas de evadir controles de
  exportación, sanciones, aduana o sistemas de pago.
• Nunca menciones usuarios finales prohibidos (gobierno cubano, militares,
  personas en listas restrictivas) — ni como audiencia ni como destinatarios.
• Neutralidad política: NUNCA menciones el embargo, el gobierno cubano o
  venezolano, políticas de EE.UU.-Cuba, regímenes, partidos, ni causas
  políticas de los apagones. Habla del apagón como un HECHO.
• PROHIBIDO terminar con cualquier disclaimer legal, referencia regulatoria,
  número de CFR, license exception, BIS, OFAC, aduana, o texto tipo pie de
  página legal. El último contenido del post debe ser el CTA + hashtags.
  NUNCA escribas frases como "Envíos a Cuba operan bajo..." o similares.

§3.2 INTEGRIDAD DE CLAIMS (FTC — TRUTH IN ADVERTISING)
• SUBSTANCIACIÓN: solo usa especificaciones que aparezcan LITERALMENTE en la
  sección "PRODUCTO DEL DÍA" arriba. Está PROHIBIDO inventar Wh, Ah, ciclos,
  horas de autonomía, watts de salida, o porcentajes de ahorro/eficiencia.
• Si el dato no está en PRODUCTO DEL DÍA, NO lo uses. Describe beneficios
  cualitativos ("luces, ventilador, nevera pequeña") sin inventar duraciones.
• Nada de urgencia falsa: prohibido "últimas X unidades", "solo hoy",
  contadores, "acaba de comprar alguien", "stock limitado", "vence hoy".
• Nada de testimonios inventados, reseñas ficticias, estrellas, ni citas de
  clientes. Tampoco menciones competidores (Bluetti, EcoFlow, Jackery) a
  menos que sea una comparación factual verificada — preferible NO hacerlo.

§3.3 HONESTIDAD Y ALCANCE
• Nunca inventes precios, fechas de entrega, garantías, certificaciones.
• Nunca des consejo médico, legal, fiscal, financiero o de ingeniería
  eléctrica. En caption y script no expliques instalación, cableado,
  configuración de inversores, o cualquier procedimiento eléctrico.
• Nunca garantices resultados fuera del control de Oiikon (tiempos de aduana
  cubana, clima, ahorros en factura).

§3.5 SENSIBILIDAD CULTURAL (NO EXPLOTAR DOLOR)
• CERO culpa al lector. Prohibido: "tú estás aquí", "tú desde aquí",
  "mientras ellos sufren", "sintiéndote impotente", "tú cómodo", "ellos no
  pueden". No contrastes tu situación con la de ellos.
• CERO explotación de sufrimiento. No hagas dramatización extendida del
  apagón, hambre, separación familiar, o huracanes para presionar la venta.
  Mención breve del contexto está OK; dwelling o amarillismo NO.
• Tono: educado, cálido, respetuoso, optimista. Somos EDUCACIÓN + VENTA.
• Sin humor ni sarcasmo que pueda malinterpretarse entre culturas.
• Lenguaje inclusivo: "familia", "seres queridos", "comunidad hispana".
  Evita estereotipos por país.

§3.6 DISCLOSURE DE IA + PROPIEDAD INTELECTUAL
• Al final del facebook_post y instagram_caption (antes de los hashtags)
  incluye la línea: "🤖 Contenido creado con IA, revisado por humanos."
• Nunca reproduzcas letras de canciones, marcas registradas sin autorización,
  ni likenesses de personas reales.

§3.8 RESTRICCIONES DE ACCIÓN
• Este contenido requiere aprobación humana antes de publicarse. Escribe
  como draft, no como pieza ya aprobada.

═══════════════════════════════════════════════════════════════════════════════

ÁNGULO DE VALOR PERMITIDO:
• La estación solar es una INVERSIÓN FAMILIAR accesible. Destaca precio
  (usa solo el que aparece en PRODUCTO DEL DÍA), durabilidad, tranquilidad.
• Educa con 1 beneficio concreto cualitativo ("mantener luces y nevera",
  "cargar celulares y router", "compatible con paneles solares").

CTAs OBLIGATORIOS:
• Incluye SIEMPRE dos llamadas a la acción al final del facebook_post,
  instagram_caption, y youtube_description:
  1. Link al producto: https://oiikon.com/product/${product.sku.toLowerCase()}
  2. Chat por WhatsApp: https://wa.me/14848644191?text=Hola%2C%20tengo%20una%20pregunta%20sobre%20el%20${product.sku}
• Formato sugerido:
  "👉 Más info: https://oiikon.com/product/${product.sku.toLowerCase()}
   💬 O chatea con nosotros: https://wa.me/14848644191"
• En el youtube_script, menciona verbalmente "También puedes escribirnos
  por WhatsApp para resolver tus dudas" cerca del final.

═══════════════════════════════════════════════════════════════════════════════

Genera el siguiente contenido de marketing en formato JSON válido. TODO en español. Sin explicaciones, solo el JSON:

{
  "daily_theme": "frase corta que capture el tema emocional de hoy (ej: Luz para tu familia en Cuba)",
  "product_sku": "${product.sku}",
  "facebook_post": "publicación de Facebook de 150-200 palabras, emocional, con emojis, menciona el problema del apagón, la solución, el precio y el link https://oiikon.com/product/${product.sku.toLowerCase()} — termina con llamada a la acción clara",
  "instagram_caption": "caption de Instagram de 80-120 palabras, emocional pero conciso, con 15-20 hashtags relevantes al final (#FamiliaAntesTodo #EnergíaSolar #PECRON #HispanosUSA #LatinosUSA #SolarPortatil #EstacionSolar #AyudaFamilia #Energia #LuzParaFamilia #ApagonCuba #ApagonVenezuela #LatinosCommunity #CubanDiaspora #OiikonSolar #EnergíaLimpia #SolarPower #HispanosBusiness)",
  "google_ad_headlines": [
    "headline 1 — máx 30 caracteres",
    "headline 2 — máx 30 caracteres",
    "headline 3 — máx 30 caracteres"
  ],
  "google_ad_descriptions": [
    "descripción 1 — máx 90 caracteres, beneficio principal",
    "descripción 2 — máx 90 caracteres, oferta o urgencia"
  ],
  "youtube_title": "título de YouTube atractivo, 60-70 caracteres, incluye PECRON y Cuba",
  "youtube_script": "script completo para video de 60-75 segundos (150-180 palabras). Formato: saludo → problema (apagones Cuba) → presentar producto → 3 beneficios clave → precio → CTA (Visita oiikon.com). Debe sonar natural hablado, con pausas marcadas con comas. En español natural.",
  "youtube_description": "descripción de YouTube de 150 palabras con el link https://oiikon.com y keywords de SEO en español",
  "youtube_tags": ["PECRON", "estacion solar portatil", "cuba apagon", "energia solar cuba", "cubano americano", "ayuda familia cuba", "solar power station", "oiikon", "${product.sku}", "luz cuba"]
}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) throw new Error('Claude did not return valid JSON for marketing content');

  const content = JSON.parse(jsonMatch[1]) as GeneratedContent;

  // Enforce Google Ads character limits
  content.google_ad_headlines = content.google_ad_headlines.map((h) => h.slice(0, 30));
  content.google_ad_descriptions = content.google_ad_descriptions.map((d) => d.slice(0, 90));

  // Strip legal disclaimers + inject WhatsApp CTA. The model keeps
  // re-adding the SCP line and dropping the WhatsApp link no matter what
  // the prompt says, so we scrub + inject deterministically.
  content.facebook_post = normalizeCaption(content.facebook_post, 'facebook');
  content.instagram_caption = normalizeCaption(content.instagram_caption, 'instagram');
  content.youtube_description = normalizeCaption(content.youtube_description, 'youtube');
  content.youtube_script = stripLegalDisclaimer(content.youtube_script);

  return content;
}

const WHATSAPP_LINK = 'https://wa.me/14848644191';

function stripLegalDisclaimer(text: string): string {
  if (!text) return text;
  const patterns = [
    /\n?\s*Envíos a Cuba operan bajo[^\n]*\.?/gi,
    /\n?\s*Envíos a Cuba\.?\s*(?=\n|$)/gi,
    /\n?\s*[^\n]*15\s*CFR\s*§?\s*740\.21[^\n]*/gi,
    /\n?\s*[^\n]*License Exception SCP[^\n]*/gi,
    /\n?\s*[^\n]*(BIS|OFAC)\b[^\n]*/g,
  ];
  let out = text;
  for (const p of patterns) out = out.replace(p, '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeCaption(text: string, channel: 'facebook' | 'instagram' | 'youtube'): string {
  if (!text) return text;
  const stripped = stripLegalDisclaimer(text);
  if (stripped.includes(WHATSAPP_LINK) || stripped.includes('wa.me/14848644191')) {
    return stripped;
  }
  // Inject WhatsApp CTA. For IG/YT keep short form ("💬 WhatsApp: ...").
  const line =
    channel === 'facebook'
      ? `💬 Chatea con nosotros por WhatsApp: ${WHATSAPP_LINK}`
      : `💬 WhatsApp: ${WHATSAPP_LINK}`;

  // Insert before the hashtags block if present, otherwise append.
  const hashtagIdx = stripped.search(/\n#\w/);
  if (hashtagIdx > 0) {
    return `${stripped.slice(0, hashtagIdx)}\n${line}${stripped.slice(hashtagIdx)}`;
  }
  return `${stripped}\n${line}`;
}

/**
 * Post-generation compliance check for Luz content.
 * Returns a list of human-readable warnings for the reviewer. Never throws —
 * a borderline violation should surface to the operator, not kill the pipeline.
 *
 * Keep keyword lists short and specific: false positives annoy the reviewer
 * more than they help.
 */
export function validateContent(content: GeneratedContent): string[] {
  const warnings: string[] = [];
  const allText = [
    content.daily_theme,
    content.facebook_post,
    content.instagram_caption,
    content.youtube_script,
    content.youtube_title,
    content.youtube_description,
    ...content.google_ad_headlines,
    ...content.google_ad_descriptions,
  ].join(' \n ').toLowerCase();

  // §3.1 Political neutrality
  const politicalTerms = [
    'gobierno cubano', 'régimen', 'regimen', 'embargo', 'dictadura',
    'castrista', 'chavista', 'maduro', 'díaz-canel', 'diaz-canel',
    'comunismo', 'comunista', 'el sistema cubano', 'el régimen',
  ];
  for (const term of politicalTerms) {
    if (allText.includes(term)) warnings.push(`Mención política: "${term}"`);
  }

  // §3.5 Guilt phrases (banned verbatim)
  const guiltPhrases = [
    'tú estás aquí', 'tu estas aqui',
    'tú desde aquí', 'tu desde aqui',
    'mientras ellos sufren', 'mientras ellos no',
    'sintiéndote impotente', 'sintiendote impotente',
    'tú cómodo', 'tu comodo',
  ];
  for (const phrase of guiltPhrases) {
    if (allText.includes(phrase)) warnings.push(`Frase de culpa: "${phrase}"`);
  }

  // §3.2 False urgency
  const urgencyPhrases = [
    'últimas unidades', 'ultimas unidades',
    'solo hoy', 'sólo hoy',
    'quedan pocas', 'stock limitado',
    'última oportunidad', 'ultima oportunidad',
    'vence hoy',
  ];
  for (const phrase of urgencyPhrases) {
    if (allText.includes(phrase)) warnings.push(`Urgencia falsa: "${phrase}"`);
  }

  // §3.2 Competitor mentions (not a hard ban but reviewer should confirm)
  const competitors = ['bluetti', 'ecoflow', 'jackery', 'anker solix', 'goalzero', 'goal zero'];
  for (const c of competitors) {
    if (allText.includes(c)) warnings.push(`Competidor mencionado: "${c}" (revisar)`);
  }

  // §3.6 AI disclosure must appear
  if (!content.facebook_post.includes('IA') && !content.facebook_post.toLowerCase().includes('inteligencia artificial')) {
    warnings.push('Falta disclosure de IA en facebook_post');
  }
  if (!content.instagram_caption.includes('IA') && !content.instagram_caption.toLowerCase().includes('inteligencia artificial')) {
    warnings.push('Falta disclosure de IA en instagram_caption');
  }

  return warnings;
}
