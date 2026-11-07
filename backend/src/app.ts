import { createClient } from '@supabase/supabase-js';
import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';

type AppConfig = {
  supabaseUrl: string;
  supabasePublishableKey: string;
  fetch?: typeof globalThis.fetch;
};

const expenseQuery = z.strictObject({
  scope: z.enum(['own', 'organization']).optional(),
  ownerId: z.uuid().optional(),
  department: z.string().trim().min(1).max(50).optional(),
  year: z.string().regex(/^[0-9]{1,4}$/).transform(Number).pipe(z.int().min(1).max(9998)).optional(),
  month: z.string().regex(/^[0-9]{1,2}$/).transform(Number).pipe(z.int().min(1).max(12)).optional(),
  limit: z.string().regex(/^[0-9]{1,3}$/).transform(Number).pipe(z.int().min(1).max(100)).optional(),
  offset: z.string().regex(/^[0-9]{1,10}$/).transform(Number).pipe(z.int().min(0).max(2_147_483_647)).optional(),
});

export function createApp(config: AppConfig) {
  const app = express();

  app.get('/api/expenses', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = /^Bearer (\S+)$/i.exec(req.get('Authorization') ?? '')?.[1];
    if (!token) {
      return res.status(401).json({ error: 'unauthenticated' });
    }

    // Create a fresh client for each request to keep callers' tokens separate.
    const supabase = createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: {
        headers: { Authorization: `Bearer ${token}` },
        fetch: config.fetch,
      },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError) {
      if (authError.status === 400 || authError.status === 401 || authError.status === 403) {
        return res.status(401).json({ error: 'unauthenticated' });
      }
      return res.status(503).json({ error: 'authentication_unavailable' });
    }
    if (!user) {
      return res.status(401).json({ error: 'unauthenticated' });
    }

    const { data: membership, error: membershipError } = await supabase
      .from('organization_members')
      .select('user_id, access_role')
      .eq('user_id', user.id)
      .maybeSingle();

    if (membershipError) throw membershipError;
    if (!membership) {
      return res.status(403).json({ error: 'membership_required' });
    }

    const query = expenseQuery.safeParse(req.query);
    if (!query.success) {
      return res.status(400).json({ error: 'invalid_expense_query' });
    }

    const scope = query.data.scope ?? 'own';
    if (scope === 'organization' && membership.access_role !== 'finance_head') {
      return res.status(403).json({ error: 'finance_head_required' });
    }
    if (
      (query.data.month !== undefined && query.data.year === undefined)
      || (scope === 'own' && (query.data.ownerId !== undefined || query.data.department !== undefined))
    ) {
      return res.status(400).json({ error: 'invalid_expense_query' });
    }

    const { data, error } = await supabase.rpc('list_expenses', {
      requested_scope: scope,
      filter_owner_id: query.data.ownerId ?? null,
      filter_department: query.data.department ?? null,
      filter_year: query.data.year ?? null,
      filter_month: query.data.month ?? null,
      page_limit: query.data.limit ?? 50,
      page_offset: query.data.offset ?? 0,
    });

    if (error?.code === '42501') {
      return res.status(403).json({ error: 'access_denied' });
    }
    if (error) throw error;
    return res.json(data);
  });

  const handleError: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(500).json({ error: 'internal_error' });
  };
  app.use(handleError);

  return app;
}
