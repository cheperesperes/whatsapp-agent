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
  capacity_wh?: number;
  output_watts?: number;
  price_usd?: number;
  sell_price?: number;
}

function pickDailyProduct(products: Product[]): Product {
  const inStock = products.filter((p) => p.sku);
  if (inStock.length === 0) return products[0];
  // Rotate by day-of-year so each day features a different product
  const dayOfYear = Math.floor(Date.now() / 86400000);
  return inStock[dayOfYear % inStock.length];
}

export async function generateMarketingContent(
  researchBrief: string,
  products: Product[]
): Promise<GeneratedContent> {
  const product = pickDailyProduct(products);
  const price = product.sell_price ?? product.price_usd ?? 0;

  const anthropic = new Anthropic();

  const prompt = `Eres el director de marketing de Oiikon (oiikon.com), tienda especializada en estaciones solares portátiles PECRON para cubano-americanos que envían equipos a Cuba, donde hay apagones de 8 a 20 horas diarias.

PRODUCTO DEL DÍA:
- Nombre: ${product.name}
- SKU: ${product.sku}
- Capacidad: ${product.capacity_wh ? product.capacity_wh + ' Wh' : 'N/A'}
- Potencia: ${product.output_watts ? product.output_watts + ' W' : 'N/A'}
- Precio: $${price} USD
- URL: https://oiikon.com/product/${product.sku.toLowerCase()}

INVESTIGACIÓN DE HOY:
${researchBrief}

AUDIENCIA PRINCIPAL:
Hispanos en EE.UU. (Miami, Tampa, Houston, New York, New Jersey, Los Angeles) con familia en Cuba, Venezuela, Haití, o cualquier país con crisis eléctrica. Motivación: amor familiar, urgencia real, solución práctica. Habla con el corazón — esta es una comunidad que se sacrifica por su familia.

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

  return content;
}
