import 'dotenv/config';
import { z } from 'zod';

const optionalBooleanEnv = z.enum(['true', 'false']).optional().transform((value) =>
  value === undefined ? undefined : value === 'true',
);

// A blank value (a bare `KEY=` line) counts as not set.
const blankIsUnset = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema);

const booleanEnv = (fallback: boolean) => z.enum(['true', 'false']).default(fallback ? 'true' : 'false').transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  LOG_PRETTY: optionalBooleanEnv,
  PORT: z.coerce.number().default(5100),
  FRONTEND_URL: z.string().default('http://localhost:5173,http://localhost:3000'),
  SLR_API_BASE_URL: z.string().url().default('http://localhost:5000'),
  SLR_API_MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  SLR_API_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // Development-only auth. It is ignored in production, so a missing deployment setting can never open the API.
  DEV_AUTH_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  DEV_AUTH_UID: z.string().default('dev_user'),
  DEV_AUTH_EMAIL: z.string().default('dev@slr-writing.local'),
  // Firebase project that issues the ID tokens (shared with slr-be). Required in production: without it every request is rejected.
  // A blank value (a bare `FIREBASE_PROJECT_ID=` line) counts as not set.
  FIREBASE_PROJECT_ID: z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), z.string().trim().min(1).optional()),
  // Also reject tokens that were revoked. This asks Firebase Auth, which needs service-account credentials in the environment.
  FIREBASE_CHECK_REVOKED: booleanEnv(false),
  // When on, creating a project asks slr-be whether the caller belongs to the SLR project being linked.
  SLR_VERIFY_PROJECT_ACCESS: booleanEnv(true),
  // H1, H2 and H3 are decided by the OWNER of the SLR project on slr-be. When on, each decision asks slr-be for the caller's role.
  // Keep it on outside of tests: with it off, anyone who owns the writing project could approve.
  REQUIRE_SLR_OWNER_FOR_APPROVAL: booleanEnv(true),
  // Importing a run posted by the client is not backed by slr-be. Off by default in production.
  ALLOW_MANUAL_SNAPSHOT_IMPORT: z.enum(['true', 'false']).optional().transform((value) => (value === undefined ? undefined : value === 'true')),
  FROM_SLR_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  // LLM. Optional: without a provider and a key, every step that needs a model answers 503 LLM_NOT_CONFIGURED.
  // 'gemini' needs GEMINI_API_KEY; 'none' switches the model off. Unset means 'gemini' when GEMINI_API_KEY is set, otherwise 'none'.
  // There is no 'mock' here on purpose: a stand-in model is put in place by tests only, never by a setting.
  LLM_PROVIDER: z.enum(['gemini', 'none']).optional(),
  GEMINI_API_KEY: blankIsUnset(z.string().trim().min(1).max(512).optional()),
  // Google retires models quickly (gemini-2.5-flash already refuses new users), so this name will need updating from time to time.
  GEMINI_MODEL: z.string().regex(/^[a-z0-9][a-z0-9.\-]{0,63}$/).default('gemini-3.5-flash'),
  GEMINI_API_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com'),
  // Thinking tokens count against the output limit: with thinking on, a short answer can use most of a small limit and be cut off.
  // 0 switches thinking off, which suits these steps (structured answers the system checks anyway). Not every model allows 0.
  GEMINI_THINKING_BUDGET: blankIsUnset(z.coerce.number().int().min(0).max(24576).default(0)),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(65_536).default(4_096),
  LLM_MAX_INPUT_CHARS: z.coerce.number().int().min(1).max(2_000_000).default(200_000),
  LLM_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  // Most tokens (input and output) the process may spend per UTC day. 0 = no limit. Counted in memory: it starts again at 0 on restart.
  LLM_DAILY_TOKEN_BUDGET: z.coerce.number().int().min(0).default(0),
  JSON_BODY_LIMIT: z.string().default('50mb'),
  DATABASE_URL: z.string().min(1).default('postgresql://slr_writing:slr_writing@localhost:5433/slr_writing?schema=public'),
});

/** Parses and checks an environment. Exported so the production rules can be tested without touching process.env. */
export function parseEnv(source: NodeJS.ProcessEnv) {
  const parsed = envSchema.parse(source);
  // Fail closed: a production server that cannot verify tokens would reject everything, so refuse to start instead.
  if (parsed.NODE_ENV === 'production' && !parsed.FIREBASE_PROJECT_ID) {
    throw new Error('FIREBASE_PROJECT_ID is required when NODE_ENV=production');
  }
  // With a verifier configured, dev auth would let anyone without a token act as any user through X-Dev-User-Id.
  if (parsed.FIREBASE_PROJECT_ID && parsed.DEV_AUTH_ENABLED) {
    throw new Error('DEV_AUTH_ENABLED cannot be true while FIREBASE_PROJECT_ID is set; use one or the other');
  }
  // The key is sent to GEMINI_API_BASE_URL, so that address must be secure. Plain http is only for a server on this machine (tests).
  const base = new URL(parsed.GEMINI_API_BASE_URL);
  const local = base.hostname === 'localhost' || base.hostname === '127.0.0.1';
  if (base.protocol !== 'https:' && !(local && parsed.NODE_ENV !== 'production')) {
    throw new Error('GEMINI_API_BASE_URL must be an https address (plain http is only allowed for localhost outside production)');
  }
  if (parsed.LLM_PROVIDER === 'gemini' && !parsed.GEMINI_API_KEY) {
    throw new Error('LLM_PROVIDER=gemini needs GEMINI_API_KEY');
  }
  return {
    ...parsed,
    // What will really be used: an explicit choice, otherwise Gemini when there is a key, otherwise nothing.
    LLM_PROVIDER: parsed.LLM_PROVIDER ?? (parsed.GEMINI_API_KEY ? ('gemini' as const) : ('none' as const)),
    ALLOW_MANUAL_SNAPSHOT_IMPORT: parsed.ALLOW_MANUAL_SNAPSHOT_IMPORT ?? parsed.NODE_ENV !== 'production',
  };
}

export const env = parseEnv(process.env);
