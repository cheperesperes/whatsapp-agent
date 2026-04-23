/**
 * Marketing Agent Memory
 *
 * The agent's own persistent learning layer. Every campaign is evaluated
 * after 24h and the findings are distilled into a memory brief that shapes
 * the next day's content. Stored entirely in Supabase — no customer data
 * is ever read or stored here.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createServiceClient } from '@/lib/supabase';
import { getRecentPerformance, listCampaigns } from './db';

export interface MarketingMemory {
  top_themes: string[];        // Themes that drove high engagement
  weak_themes: string[];       // Themes that underperformed
  best_days: string[];         // Day-of-week patterns (e.g. "domingo", "viernes")
  style_notes: string;         // Claude's synthesis of what resonates
  group_insights: string;      // Notes on which Facebook groups were most active
  product_rotation: string[];  // SKUs used recently (avoid repeating)
  updated_at: string;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

export async function saveMemory(memory: MarketingMemory) {
  const sb = createServiceClient();
  await sb.from('marketing_agent_memory').upsert(
    { id: 1, ...memory, updated_at: new Date().toISOString() },
    { onConflict: 'id' }
  );
}

export async function loadMemory(): Promise<MarketingMemory | null> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('marketing_agent_memory')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  return data as MarketingMemory | null;
}

// ── Memory brief for prompt injection ────────────────────────────────────────

export function formatMemoryForPrompt(memory: MarketingMemory | null): string {
  if (!memory) return '';

  const parts: string[] = ['MEMORIA DEL AGENTE (aprendizajes anteriores):'];

  if (memory.top_themes.length > 0) {
    parts.push(`✅ Temas que funcionaron bien: ${memory.top_themes.join(', ')}`);
  }
  if (memory.weak_themes.length > 0) {
    parts.push(`❌ Temas que no funcionaron: ${memory.weak_themes.join(', ')}`);
  }
  if (memory.style_notes) {
    parts.push(`📝 Estilo: ${memory.style_notes}`);
  }
  if (memory.group_insights) {
    parts.push(`👥 Grupos: ${memory.group_insights}`);
  }
  if (memory.product_rotation.length > 0) {
    parts.push(`🔄 Productos recientes (no repetir): ${memory.product_rotation.slice(-5).join(', ')}`);
  }

  return parts.join('\n');
}

// ── Post-campaign learning ────────────────────────────────────────────────────

export async function consolidateMemory(): Promise<void> {
  const [recentPerf, recentCampaigns, existingMemory] = await Promise.all([
    getRecentPerformance(14),
    listCampaigns(14),
    loadMemory(),
  ]);

  if (recentPerf.length === 0 && !existingMemory) return;

  // Build performance summary for Claude
  const perfLines: string[] = [];
  for (const perf of recentPerf) {
    const campaign = recentCampaigns.find((c) => c.id === perf.campaign_id);
    if (!campaign) continue;
    const totalEngagement =
      perf.facebook_likes + perf.facebook_comments * 3 + perf.facebook_shares * 5 +
      perf.youtube_views * 0.1 + perf.youtube_likes * 2;
    perfLines.push(
      `[${campaign.date}] Tema: "${campaign.daily_theme}" | Producto: ${campaign.product_sku} | ` +
      `FB: ${perf.facebook_likes}❤️ ${perf.facebook_comments}💬 ${perf.facebook_shares}🔄 | ` +
      `YT: ${perf.youtube_views}👁️ ${perf.youtube_likes}❤️ | Score: ${totalEngagement.toFixed(0)}`
    );
  }

  const recentSkus = recentCampaigns
    .filter((c) => c.product_sku)
    .map((c) => c.product_sku as string)
    .slice(0, 7);

  // Ask Claude to synthesize learnings
  const anthropic = new Anthropic();
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [
      {
        role: 'user',
        content: `Eres el analista de marketing de Oiikon. Analiza el rendimiento de las últimas campañas y extrae aprendizajes claros para mejorar las próximas.

DATOS DE RENDIMIENTO (últimas 2 semanas):
${perfLines.length > 0 ? perfLines.join('\n') : 'Sin datos de rendimiento aún.'}

MEMORIA ANTERIOR:
${existingMemory ? JSON.stringify(existingMemory, null, 2) : 'Ninguna.'}

Devuelve un JSON con estos campos (en español):
{
  "top_themes": ["tema1", "tema2", "tema3"],
  "weak_themes": ["tema1", "tema2"],
  "best_days": ["viernes", "domingo"],
  "style_notes": "una oración sobre qué estilo de copy funcionó mejor",
  "group_insights": "una oración sobre qué grupos de Facebook respondieron mejor"
}

Solo el JSON, sin texto adicional.`,
      },
    ],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) return;

  const learnings = JSON.parse(jsonMatch[1]) as Partial<MarketingMemory>;

  await saveMemory({
    top_themes: learnings.top_themes ?? existingMemory?.top_themes ?? [],
    weak_themes: learnings.weak_themes ?? existingMemory?.weak_themes ?? [],
    best_days: learnings.best_days ?? existingMemory?.best_days ?? [],
    style_notes: learnings.style_notes ?? existingMemory?.style_notes ?? '',
    group_insights: learnings.group_insights ?? existingMemory?.group_insights ?? '',
    product_rotation: recentSkus,
    updated_at: new Date().toISOString(),
  });
}
