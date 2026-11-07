import { z } from 'zod';
import { createApp } from './app.ts';

const config = z.object({
  SUPABASE_URL: z.url({ protocol: /^https?$/ }),
  SUPABASE_PUBLISHABLE_KEY: z.string().regex(/^sb_publishable_\S+$/),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().regex(/^[a-zA-Z0-9.-]+$/).default('gemini-3.5-flash-lite'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
}).safeParse(process.env);

if (!config.success) {
  const names = config.error.issues.map(issue => issue.path.join('.')).join(', ');
  throw new Error(`Missing or invalid configuration: ${names}`);
}

const app = createApp({
  supabaseUrl: config.data.SUPABASE_URL,
  supabasePublishableKey: config.data.SUPABASE_PUBLISHABLE_KEY,
  geminiApiKey: config.data.GEMINI_API_KEY,
  geminiModel: config.data.GEMINI_MODEL,
});

app.listen(config.data.PORT, '127.0.0.1', () => {
  console.log(`Receipt Scanner API listening on http://127.0.0.1:${config.data.PORT}`);
});
