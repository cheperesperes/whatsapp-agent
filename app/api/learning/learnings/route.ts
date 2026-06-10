import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import {
  violatesHardRules,
  invalidateLearningsCache,
  LEARNING_CATEGORIES,
  type LearningCategory,
} from '@/lib/learning';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Operator management of sol_learnings (session-protected by middleware).
// POST = add manual coaching directive. PATCH = activate/retire a row.

export async function POST(req: NextRequest) {
  let body: { directive?: string; category?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const directive = (body.directive ?? '').trim().slice(0, 220);
  if (directive.length < 10) {
    return NextResponse.json({ error: 'directive too short (min 10 chars)' }, { status: 400 });
  }
  if (violatesHardRules(directive)) {
    return NextResponse.json(
      {
        error:
          'La directiva viola una regla dura (precios, tiempos de entrega, Cuba o cupones no van en el coaching).',
      },
      { status: 400 }
    );
  }
  const category = LEARNING_CATEGORIES.includes(body.category as LearningCategory)
    ? (body.category as string)
    : 'general';

  const sb = createServiceClient();
  const { data, error } = await sb
    .from('sol_learnings')
    .insert({ directive, category, source: 'manual', status: 'active' })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  invalidateLearningsCache();
  return NextResponse.json({ ok: true, learning: data });
}

export async function PATCH(req: NextRequest) {
  let body: { id?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const id = (body.id ?? '').trim();
  const status = body.status === 'retired' ? 'retired' : body.status === 'active' ? 'active' : null;
  if (!id || !status) {
    return NextResponse.json({ error: 'id and status (active|retired) required' }, { status: 400 });
  }

  const sb = createServiceClient();
  const { error } = await sb
    .from('sol_learnings')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  invalidateLearningsCache();
  return NextResponse.json({ ok: true });
}
