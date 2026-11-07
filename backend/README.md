# Receipt Scanner backend

Milestones 1–3 expose personal expense management and Finance Head reporting. Use Node.js 24 or newer.

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
Members can create, edit and delete their own expenses. Finance Head can read team
expenses and manage their own expenses.

## Expense writes

All write routes require a verified Supabase access token and active membership.
Apply `20261107000002_expense_writes.sql` after the two earlier migrations.

| Request | Body | Successful response |
| --- | --- | --- |
| `POST /api/expenses` | All three fields below | `201` and the new expense |
| `PATCH /api/expenses/:id` | One or more of those fields | `200` and the updated expense |
| `DELETE /api/expenses/:id` | None | `204` with an empty body |

```json
{
  "shopName": "Sample shop",
  "purchaseDate": "2026-11-07",
  "totalPaidSatang": 4500
}
```

Shop names are trimmed and must have 1–200 characters. Purchase dates must be real
calendar dates in `YYYY-MM-DD` format, from year 0001. Amounts are integer satang
from 0 to 2147483647. PATCH requires at least one field. Unexpected fields,
including ownership and system-generated fields, return `400`.

PostgreSQL generates the expense ID and assigns ownership from the caller's verified
identity. Column privileges prevent users from inserting or changing `owner_id`.
Each write is a single database statement. RLS requires current membership and
ownership for writes, including requests made directly to Supabase.

PATCH and DELETE return `404` when there is no matching owned expense.
Malformed JSON returns `400`; JSON bodies over 16 KB return `413`.
New POST requests create separate expense records. Exact receipt-photo duplicate
detection and line-item reconciliation belong to the scan-and-confirm milestone.

## Run the tests

Run `npm test` and `npm run typecheck` from this directory. Supertest calls the Express app on a loopback port. The suite applies the migration to PGlite and runs the database queries as separate users. It uses a simulated Supabase HTTP service for authentication and the Data API, so the suite runs without project credentials.
