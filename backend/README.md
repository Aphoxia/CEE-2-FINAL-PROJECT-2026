# Receipt Scanner backend

Milestones 1 and 2 expose personal expense lists and Finance Head reporting. Use Node.js 24 or newer.

## Run locally

1. Apply the SQL files in `supabase/migrations/` to a development Supabase project, in filename order.
2. Create two test users under **Authentication → Users**. Use their UUIDs to add membership rows and expenses in the SQL editor. Run the following once per test user, replacing the UUID and sample values.

   ```sql
   insert into public.organization_members (user_id)
   values ('<test-user-uuid>');

   insert into public.expenses (owner_id, shop_name, purchase_date, total_paid_satang)
   values ('<test-user-uuid>', 'Sample shop', '2026-11-07', 4500);
   ```

3. From this directory run `npm ci`, copy `.env.example` to `.env`, and fill in the development project's URL and publishable key. Run `npm run dev`.
4. Sign in with a test user through Supabase Auth and pass that session's access token to the API. The example reads the token from your shell environment.

   ```sh
   curl -H "Authorization: Bearer ${RECEIPT_TEST_ACCESS_TOKEN}" \
     'http://127.0.0.1:3000/api/expenses?limit=10&offset=0'
   ```

The endpoint returns `expenses`, `runningTotalSatang`, and `totalCount`. Each expense has `id`, `shopName`, `purchaseDate`, and `totalPaidSatang`. The total and count cover all of the caller's expenses. Pages are sorted by purchase date descending, with the expense ID as a tie breaker.

## Finance Head reporting

A trusted project administrator assigns Finance Head access in the SQL editor.

```sql
update public.organization_members
set access_role = 'finance_head'
where user_id = '<finance-head-user-uuid>';
```

`GET /api/expenses` defaults to `scope=own` for every user. Finance Head can request
`GET /api/expenses?scope=organization&year=2026&month=11&department=IT&limit=10`.
Organization results also include `ownerId`. Filters apply before pagination and totals.

| Query parameter | Meaning |
| --- | --- |
| `scope` | `own` or `organization`. Organization scope requires Finance Head. |
| `ownerId` | Owner UUID. Available in organization scope. |
| `department` | Exact, case-sensitive current department name. Available in organization scope. |
| `year` | Purchase year from 1 to 9998. |
| `month` | Purchase month from 1 to 12. Requires `year`. |
| `limit`, `offset` | Page size from 1 to 100 (default 50), and zero-based offset (default 0). |

The development database represents one team. Organization reports include all retained
expenses, including those owned by users whose membership has been removed.
Department filters use current assignments. An expense contributes once even when
its owner belongs to multiple departments. Administrators can populate `departments`
and `user_departments` with development data in the SQL editor.
Finance Head status is read from the protected membership table for each request.
Authenticated application users have read privileges only in this milestone.

## Run the tests

Run `npm test` and `npm run typecheck` from this directory. Supertest calls the Express app on a loopback port. The suite applies the migration to PGlite and runs the database queries as separate users. It uses a simulated Supabase HTTP service for authentication and the Data API, so the suite runs without project credentials.
