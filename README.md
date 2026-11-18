# Receipt Scanner

AI-assisted receipt and transfer-slip scanner for recording, reviewing, and organizing team expenses in THB. Users manage their own expenses; Finance Head can view organization-wide expenses and summaries.

## Technology

- **Frontend:** React, TypeScript, Vite
- **Backend:** Node.js, Express, TypeScript
- **Authentication and database:** Supabase Auth and PostgreSQL
- **Receipt extraction:** Gemini API
- **Validation:** Zod
- **Tests:** Vitest and Supertest
- **Hosting:** Vercel

## Repository structure

```text
api/                     Vercel function adapters for the Express API
backend/
  src/                   Express routes, configuration, and receipt extraction
  tests/                 API and receipt extraction tests
frontend/
  src/                   React application, styling, and money helpers
supabase/
  migrations/            Database schema, RLS, and RPC migrations
CONTEXT.md               Domain terms and authorization model
DEPLOYMENT.md            Vercel and Supabase deployment configuration
TERMINAL_GUIDE.md        Git and Vercel command guide
```

## Local development

1. Apply the SQL migrations in `supabase/migrations/` to a development Supabase project.
2. Copy `backend/.env.example` to `backend/.env` and add the backend settings. Keep API keys and secrets out of Git.
3. Copy `frontend/.env.example` to `frontend/.env` and add the Supabase URL and publishable key.
4. In separate terminals, run `npm run dev` in `backend/` and `frontend/`.
5. Run the checks with `npm test --prefix backend`, `npm test --prefix frontend`, and `npm run build --prefix frontend`.

See [DEPLOYMENT.md](DEPLOYMENT.md) for production environment settings and [TERMINAL_GUIDE.md](TERMINAL_GUIDE.md) for the Git/Vercel workflow.
