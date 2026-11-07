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
  await db.exec(await readFile(
    new URL('../../supabase/migrations/20261107000002_expense_writes.sql', import.meta.url),
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
    case '/rest/v1/expenses': {
      const returning = `id, shop_name as "shopName", purchase_date::text as "purchaseDate",
        total_paid_satang as "totalPaidSatang"`;
      let result;
      const id = url.searchParams.get('id')?.replace(/^eq\./, '');
      const ownerId = url.searchParams.get('owner_id')?.replace(/^eq\./, '');
      if (req.method === 'POST') {
        const body = await req.json();
        result = await queryAsUser(userId, `
          insert into public.expenses (shop_name, purchase_date, total_paid_satang)
          values ($1, $2, $3) returning ${returning}
        `, [body.shop_name, body.purchase_date, body.total_paid_satang]);
      } else if (req.method === 'PATCH') {
        const body: Record<string, unknown> = await req.json();
        const columns = Object.keys(body);
        const allowedColumns = ['shop_name', 'purchase_date', 'total_paid_satang'];
        if (columns.some(column => !allowedColumns.includes(column))) {
          throw new Error('Unexpected update column in test transport');
        }
        const assignments = columns.map((column, index) => `${column} = $${index + 3}`);
        result = await queryAsUser(userId, `
          update public.expenses set ${assignments.join(', ')}
          where id = $1 and owner_id = $2 returning ${returning}
        `, [id, ownerId, ...Object.values(body)]);
      } else if (req.method === 'DELETE') {
        result = await queryAsUser(userId, `
          delete from public.expenses where id = $1 and owner_id = $2 returning id
        `, [id, ownerId]);
      } else {
        throw new Error('Unexpected expense request method');
      }
      const data = req.headers.get('Accept') === 'application/vnd.pgrst.object+json'
        ? result.rows[0] : result.rows;
      return Response.json(data, { status: req.method === 'POST' ? 201 : 200 });
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

  it('denies self-promotion and writes to another member\'s expenses', async () => {
    await expect(queryAsUser(alice,
      "update public.organization_members set access_role = 'finance_head' where user_id = $1",
      [alice])).rejects.toMatchObject({ code: '42501' });
    const result = await queryAsUser(alice,
      'delete from public.expenses where owner_id = $1 returning id', [bob]);
    expect(result.rows).toEqual([]);
  });

  it('enforces Finance Head access when the API is bypassed', async () => {
    const { rows } = await queryAsUser(may, 'select id from public.expenses');
    expect(rows).toHaveLength(4);
    await expect(queryAsUser(alice,
      "select public.list_expenses('organization', null, null, null, null, 50, 0)"))
      .rejects.toMatchObject({ code: '42501' });
    const deleted = await queryAsUser(may,
      'delete from public.expenses where owner_id = $1 returning id', [bob]);
    expect(deleted.rows).toEqual([]);
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

describe('expense writes', () => {
  const fields = { shopName: 'ร้านทดสอบ', purchaseDate: '2026-11-07', totalPaidSatang: 4500 };

  it('creates, partially updates and deletes an owned expense, updating the running total', async () => {
    const created = await request(app).post('/api/expenses')
      .auth('empty-member-token', { type: 'bearer' }).send(fields).expect(201);
    const id: string = created.body.id;
    try {
      expect(created.body).toEqual({ id: expect.any(String), ...fields });
      const stored = await db.query('select owner_id from public.expenses where id = $1', [id]);
      expect(stored.rows).toEqual([{ owner_id: emptyMember }]);
      const updated = await request(app).patch(`/api/expenses/${id}`)
        .auth('empty-member-token', { type: 'bearer' })
        .send({ totalPaidSatang: 5000 }).expect(200);
      expect(updated.body).toEqual({ id, ...fields, totalPaidSatang: 5000 });
      const list = await request(app).get('/api/expenses')
        .auth('empty-member-token', { type: 'bearer' }).expect(200);
      expect(list.body).toMatchObject({ runningTotalSatang: 5000, totalCount: 1 });
      await request(app).delete(`/api/expenses/${id}`)
        .auth('empty-member-token', { type: 'bearer' }).expect(204);
      await request(app).delete(`/api/expenses/${id}`)
        .auth('empty-member-token', { type: 'bearer' }).expect(404);
      await request(app).get('/api/expenses')
        .auth('empty-member-token', { type: 'bearer' })
        .expect(200, { expenses: [], runningTotalSatang: 0, totalCount: 0 });
    } finally {
      await db.query('delete from public.expenses where owner_id = $1', [emptyMember]);
    }
  });

  it('requires authentication and membership for every write method', async () => {
    for (const method of ['post', 'patch', 'delete'] as const) {
      const path = method === 'post' ? '/api/expenses' : `/api/expenses/${alice}`;
      await request(app)[method](path).send(fields).expect(401);
      await request(app)[method](path).auth('invalid-token', { type: 'bearer' })
        .send(fields).expect(401);
      await request(app)[method](path).auth('guest-token', { type: 'bearer' })
        .send(fields).expect(403);
    }
  });

  it('rejects invalid business fields, ownership and server-managed fields', async () => {
    for (const payload of [
      { ...fields, ownerId: bob }, { ...fields, owner_id: bob },
      { ...fields, id: alice }, { ...fields, created_at: '2026-11-07' },
      { ...fields, shopName: '  ' }, { ...fields, purchaseDate: '2026-02-30' },
      { ...fields, purchaseDate: '0000-01-01' },
      { ...fields, totalPaidSatang: -1 }, { ...fields, totalPaidSatang: 1.5 },
      { ...fields, totalPaidSatang: '4500' }, { ...fields, totalPaidSatang: 2147483648 },
    ]) {
      await request(app).post('/api/expenses').auth('alice-token', { type: 'bearer' })
        .send(payload).expect(400);
    }
    for (const payload of [{}, { ownerId: bob }, { owner_id: bob }, { totalPaidSatang: null }]) {
      await request(app).patch(`/api/expenses/${alice}`)
        .auth('alice-token', { type: 'bearer' }).send(payload).expect(400);
    }
    await request(app).patch('/api/expenses/invalid')
      .auth('alice-token', { type: 'bearer' }).send({ shopName: 'New shop' }).expect(400);
    await request(app).delete('/api/expenses/invalid')
      .auth('alice-token', { type: 'bearer' }).expect(400);
  });

  it('returns 404 for missing expenses and other owners, including Finance Head requests', async () => {
    const result = await db.query<{ id: string }>(
      "select id from public.expenses where shop_name = 'Bob shop'",
    );
    const bobExpense = result.rows[0].id;
    for (const token of ['alice-token', 'may-token']) {
      for (const id of [bobExpense, alice]) {
        await request(app).patch(`/api/expenses/${id}`)
          .auth(token, { type: 'bearer' }).send({ totalPaidSatang: 1 }).expect(404);
        await request(app).delete(`/api/expenses/${id}`)
          .auth(token, { type: 'bearer' }).expect(404);
      }
    }
    const original = await db.query('select total_paid_satang from public.expenses where id = $1',
      [bobExpense]);
    expect(original.rows).toEqual([{ total_paid_satang: 8000 }]);
  });

  it('rejects malformed and oversized JSON bodies', async () => {
    await request(app).post('/api/expenses').auth('alice-token', { type: 'bearer' })
      .set('Content-Type', 'application/json').send('{"shopName":')
      .expect(400, { error: 'invalid_json' });
    await request(app).post('/api/expenses').auth('alice-token', { type: 'bearer' })
      .send({ ...fields, shopName: 'x'.repeat(20_000) })
      .expect(413, { error: 'request_too_large' });
  });

  it('assigns the verified caller as owner and prevents owner reassignment in SQL', async () => {
    const inserted = await queryAsUser<{ id: string; owner_id: string }>(emptyMember, `
      insert into public.expenses (shop_name, purchase_date, total_paid_satang)
      values ('Direct insert', '2026-11-07', 100) returning id, owner_id
    `);
    const id = inserted.rows[0].id;
    try {
      expect(inserted.rows[0].owner_id).toBe(emptyMember);
      await expect(queryAsUser(emptyMember,
        'update public.expenses set owner_id = $1 where id = $2', [bob, id]))
        .rejects.toMatchObject({ code: '42501' });
      await expect(queryAsUser(emptyMember, `
        insert into public.expenses (owner_id, shop_name, purchase_date, total_paid_satang)
        values ($1, 'Spoofed', '2026-11-07', 100)
      `, [bob])).rejects.toMatchObject({ code: '42501' });
      await expect(queryAsUser(guest, `
        insert into public.expenses (shop_name, purchase_date, total_paid_satang)
        values ('No membership', '2026-11-07', 100)
      `)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await db.query('delete from public.expenses where id = $1', [id]);
    }
  });

  it('blocks direct cross-owner updates and rolls back invalid changes atomically', async () => {
    for (const user of [alice, may]) {
      const result = await queryAsUser(user, `
        update public.expenses set total_paid_satang = 1 where owner_id = $1 returning id
      `, [bob]);
      expect(result.rows).toEqual([]);
    }
    await expect(queryAsUser(bob, `
      update public.expenses set shop_name = 'Changed', total_paid_satang = -1 where owner_id = $1
    `, [bob])).rejects.toMatchObject({ code: '23514' });
    const result = await queryAsUser(bob,
      'select shop_name, total_paid_satang from public.expenses where owner_id = $1', [bob]);
    expect(result.rows).toEqual([{ shop_name: 'Bob shop', total_paid_satang: 8000 }]);
  });

  it('allows Finance Head to manage their own expenses', async () => {
    const created = await request(app).post('/api/expenses')
      .auth('may-token', { type: 'bearer' }).send(fields).expect(201);
    try {
      await request(app).patch(`/api/expenses/${created.body.id}`)
        .auth('may-token', { type: 'bearer' }).send({ shopName: 'May shop' }).expect(200);
      await request(app).delete(`/api/expenses/${created.body.id}`)
        .auth('may-token', { type: 'bearer' }).expect(204);
    } finally {
      await db.query('delete from public.expenses where id = $1', [created.body.id]);
    }
  });
});
