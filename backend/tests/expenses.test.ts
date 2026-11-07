import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';

const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const guest = '00000000-0000-4000-8000-000000000003';
const emptyMember = '00000000-0000-4000-8000-000000000004';
const may = '00000000-0000-4000-8000-000000000005';
const users = new Map([
  ['alice-token', alice],
  ['bob-token', bob],
  ['guest-token', guest],
  ['empty-member-token', emptyMember],
  ['may-token', may],
]);

const db = new PGlite();

beforeAll(async () => {
  // Stand-ins for the roles and verified JWT identity Supabase sets before running SQL.
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
    $$;
    grant usage on schema auth to authenticated;
  `);
  await db.exec(await readFile(
    new URL('../../supabase/migrations/20261107000000_expense_list.sql', import.meta.url),
    'utf8',
  ));
  await db.exec(await readFile(
    new URL('../../supabase/migrations/20261107000001_finance_expense_list.sql', import.meta.url),
    'utf8',
  ));
  await db.query('insert into auth.users (id) values ($1), ($2), ($3), ($4), ($5)', [
    alice, bob, guest, emptyMember, may,
  ]);
  await db.query(
    "insert into public.organization_members (user_id, access_role) values ($1, 'finance_head')",
    [may],
  );
  await db.exec("insert into public.departments (name) values ('IT'), ('BOARD')");
  await db.query(`
    insert into public.user_departments (user_id, department_name)
    values ($1, 'IT'), ($1, 'BOARD'), ($2, 'BOARD')
  `, [alice, bob]);
  await db.query('insert into public.organization_members (user_id) values ($1), ($2), ($3)', [
    alice, bob, emptyMember,
  ]);
  await db.query(`
    insert into public.expenses (owner_id, shop_name, purchase_date, total_paid_satang)
    values ($1, 'Alice shop', '2026-11-07', 4500),
           ($1, 'Alice older shop', '2026-11-06', 1000),
           ($2, 'Bob shop', '2026-11-07', 8000),
           ($3, 'Guest shop', '2026-11-07', 9000)
  `, [alice, bob, guest]);
}, 30_000);

afterAll(() => db.close());

function queryAsUser<Row = unknown>(userId: string, sql: string, parameters: unknown[] = []) {
  return db.transaction(async tx => {
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId }),
    ]);
    return tx.query<Row>(sql, parameters);
  });
}

// Replace Supabase's HTTP services in tests. The app still uses the actual
// client library and forwards its token to PostgreSQL-backed queries.
const supabaseFetch = vi.fn<typeof fetch>(async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const userId = users.get(req.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '');
  if (!userId) {
    return Response.json({ code: 'bad_jwt', message: 'Invalid token' }, { status: 401 });
  }

  switch (url.pathname) {
    case '/auth/v1/user':
      return Response.json({ id: userId, aud: 'authenticated' });
    case '/rest/v1/organization_members': {
      const requestedUser = url.searchParams.get('user_id')?.replace(/^eq\./, '');
      const { rows } = await queryAsUser(userId,
        'select user_id, access_role from public.organization_members where user_id = $1', [requestedUser]);
      return Response.json(rows);
    }
    case '/rest/v1/rpc/list_expenses': {
      const args = await req.json();
      const { rows } = await queryAsUser<{ result: unknown }>(
        userId, 'select public.list_expenses($1, $2, $3, $4, $5, $6, $7) as result',
        [args.requested_scope, args.filter_owner_id, args.filter_department,
          args.filter_year, args.filter_month, args.page_limit, args.page_offset],
      );
      return Response.json(rows[0].result);
    }
    default:
      throw new Error(`Unexpected test request to ${url.pathname}`);
  }
});

const app = createApp({
  supabaseUrl: 'https://receipt-test.example',
  supabasePublishableKey: 'sb_publishable_fixture',
  fetch: supabaseFetch,
});

describe('GET /api/expenses', () => {
  it('rejects missing and invalid bearer tokens', async () => {
    await request(app).get('/api/expenses').expect(401, { error: 'unauthenticated' });
    await request(app).get('/api/expenses').auth('invalid-token', { type: 'bearer' })
      .expect(401, { error: 'unauthenticated' });
  });

  it('rejects a signed-in user without membership', async () => {
    await request(app).get('/api/expenses').auth('guest-token', { type: 'bearer' })
      .expect(403, { error: 'membership_required' });
  });

  it('rejects caller-supplied owner IDs and invalid pagination', async () => {
    for (const query of [`?ownerId=${bob}`, '?limit=0', '?offset=2147483648', '?limit=1&limit=2']) {
      await request(app).get(`/api/expenses${query}`).auth('alice-token', { type: 'bearer' })
        .expect(400, { error: 'invalid_expense_query' });
    }
  });

  it('isolates each caller and reports the full running total across pages', async () => {
    const [aliceResponse, bobResponse] = await Promise.all([
      request(app).get('/api/expenses?limit=1').auth('alice-token', { type: 'bearer' }).expect(200),
      request(app).get('/api/expenses').auth('bob-token', { type: 'bearer' }).expect(200),
    ]);

    expect(aliceResponse.body).toEqual({
      expenses: [{
        id: expect.any(String),
        shopName: 'Alice shop',
        purchaseDate: '2026-11-07',
        totalPaidSatang: 4500,
      }],
      runningTotalSatang: 5500,
      totalCount: 2,
    });
    expect(aliceResponse.headers['cache-control']).toBe('no-store');
    expect(bobResponse.body).toMatchObject({
      expenses: [{ shopName: 'Bob shop', totalPaidSatang: 8000 }],
      runningTotalSatang: 8000,
      totalCount: 1,
    });
    const next = await request(app).get('/api/expenses?limit=1&offset=1')
      .auth('alice-token', { type: 'bearer' }).expect(200);
    expect(next.body.expenses).toMatchObject([{ shopName: 'Alice older shop' }]);
  });

  it('returns an empty list and zero total for a member with no expenses', async () => {
    await request(app).get('/api/expenses').auth('empty-member-token', { type: 'bearer' })
      .expect(200, { expenses: [], runningTotalSatang: 0, totalCount: 0 });
  });

  it('restricts organization scope to Finance Head even with a forged role parameter', async () => {
    await request(app).get('/api/expenses?scope=organization')
      .auth('alice-token', { type: 'bearer' }).expect(403, { error: 'finance_head_required' });
    await request(app).get('/api/expenses?scope=organization&access_role=finance_head')
      .auth('alice-token', { type: 'bearer' }).expect(400);
  });

  it('lets Finance Head read all retained expenses without duplicating multi-department users', async () => {
    const response = await request(app).get('/api/expenses?scope=organization&limit=1')
      .auth('may-token', { type: 'bearer' }).expect(200);
    expect(response.body).toMatchObject({
      expenses: [{ ownerId: expect.any(String) }],
      runningTotalSatang: 22500,
      totalCount: 4,
    });
    const own = await request(app).get('/api/expenses')
      .auth('may-token', { type: 'bearer' }).expect(200);
    expect(own.body).toEqual({ expenses: [], runningTotalSatang: 0, totalCount: 0 });
  });

  it('combines owner, current department, year and month filters before computing totals', async () => {
    const response = await request(app)
      .get(`/api/expenses?scope=organization&ownerId=${alice}&department=BOARD&year=2026&month=11&limit=1`)
      .auth('may-token', { type: 'bearer' }).expect(200);
    expect(response.body).toMatchObject({ runningTotalSatang: 5500, totalCount: 2 });
    const board = await request(app).get('/api/expenses?scope=organization&department=BOARD')
      .auth('may-token', { type: 'bearer' }).expect(200);
    expect(board.body).toMatchObject({ runningTotalSatang: 13500, totalCount: 3 });
    const mismatch = await request(app)
      .get(`/api/expenses?scope=organization&ownerId=${bob}&department=IT`)
      .auth('may-token', { type: 'bearer' }).expect(200);
    expect(mismatch.body).toEqual({ expenses: [], runningTotalSatang: 0, totalCount: 0 });
  });

  it('filters purchase dates for personal and organization scope, including empty periods', async () => {
    for (const query of ['?year=2025&month=11', '?year=2026&month=12']) {
      const response = await request(app).get(`/api/expenses${query}`)
        .auth('alice-token', { type: 'bearer' }).expect(200);
      expect(response.body).toEqual({ expenses: [], runningTotalSatang: 0, totalCount: 0 });
    }
    const response = await request(app)
      .get('/api/expenses?scope=organization&year=2026&month=12')
      .auth('may-token', { type: 'bearer' }).expect(200);
    expect(response.body.totalCount).toBe(0);
  });

  it('rejects invalid filters', async () => {
    for (const query of ['?month=11', '?year=2026&month=13', '?scope=other', '?year=0',
      '?scope=organization&ownerId=wrong', '?scope=organization&department=']) {
      await request(app).get(`/api/expenses${query}`)
        .auth('may-token', { type: 'bearer' }).expect(400);
    }
  });

  it('excludes other years and months when matching expenses also exist', async () => {
    const inserted = await db.query<{ id: string }>(`
      insert into public.expenses (owner_id, shop_name, purchase_date, total_paid_satang)
      values ($1, 'Previous year', '2025-11-07', 100),
             ($1, 'Next month', '2026-12-07', 200)
      returning id
    `, [alice]);
    try {
      const november = await request(app)
        .get('/api/expenses?scope=organization&department=IT&year=2026&month=11')
        .auth('may-token', { type: 'bearer' }).expect(200);
      expect(november.body).toMatchObject({ runningTotalSatang: 5500, totalCount: 2 });
      const year = await request(app).get('/api/expenses?year=2026')
        .auth('alice-token', { type: 'bearer' }).expect(200);
      expect(year.body).toMatchObject({ runningTotalSatang: 5700, totalCount: 3 });
    } finally {
      await db.query('delete from public.expenses where id = any($1::uuid[])',
        [inserted.rows.map(row => row.id)]);
    }
  });
});

describe('database permissions without Express', () => {
  it('shows each member only their own rows, including when they query a different owner', async () => {
    const aliceRows = await queryAsUser(alice, 'select distinct owner_id from public.expenses');
    const bobRows = await queryAsUser(bob, 'select distinct owner_id from public.expenses');
    const crossUserRows = await queryAsUser(alice,
      'select id from public.expenses where owner_id = $1', [bob]);
    const guestRows = await queryAsUser(guest, 'select id from public.expenses');

    expect(aliceRows.rows).toEqual([{ owner_id: alice }]);
    expect(bobRows.rows).toEqual([{ owner_id: bob }]);
    expect(crossUserRows.rows).toEqual([]);
    expect(guestRows.rows).toEqual([]);
  });

  it('denies self-promotion and expense writes in the read-only milestone', async () => {
    await expect(queryAsUser(alice,
      "update public.organization_members set access_role = 'finance_head' where user_id = $1",
      [alice])).rejects.toMatchObject({ code: '42501' });
    await expect(queryAsUser(alice, 'delete from public.expenses where owner_id = $1',
      [alice])).rejects.toMatchObject({ code: '42501' });
  });

  it('enforces Finance Head access when the API is bypassed', async () => {
    const { rows } = await queryAsUser(may, 'select id from public.expenses');
    expect(rows).toHaveLength(4);
    await expect(queryAsUser(alice,
      "select public.list_expenses('organization', null, null, null, null, 50, 0)"))
      .rejects.toMatchObject({ code: '42501' });
    await expect(queryAsUser(may, 'delete from public.expenses where owner_id = $1', [bob]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(queryAsUser(alice,
      "insert into public.user_departments (user_id, department_name) values ($1, 'IT')", [bob]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(queryAsUser(may,
      "select public.list_expenses('organization', null, null, null, 11, 50, 0)"))
      .rejects.toMatchObject({ code: '22023' });
  });

  it('uses the current protected role after a Finance Head is demoted', async () => {
    await db.query("update public.organization_members set access_role = 'member' where user_id = $1",
      [may]);
    try {
      await request(app).get('/api/expenses?scope=organization')
        .auth('may-token', { type: 'bearer' }).expect(403);
      const { rows } = await queryAsUser(may, 'select id from public.expenses');
      expect(rows).toEqual([]);
      await expect(queryAsUser(may,
        "select public.list_expenses('organization', null, null, null, null, 50, 0)"))
        .rejects.toMatchObject({ code: '42501' });
    } finally {
      await db.query(
        "update public.organization_members set access_role = 'finance_head' where user_id = $1", [may],
      );
    }
  });
});
