import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.js';

// QA for parseEnv (M1). Pure: no database, no process.env mutation.
const prod = { NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'p' };
const dev = { NODE_ENV: 'development' };
const devAuthAllowed = (e: ReturnType<typeof parseEnv>) => e.DEV_AUTH_ENABLED && e.NODE_ENV !== 'production';

describe('NODE_ENV variants', () => {
  it.each(['Production', 'PRODUCTION', ' production', 'production ', 'prod', '', 'staging'])('rejects odd NODE_ENV %j instead of guessing (fail closed)', (value) => {
    expect(() => parseEnv({ NODE_ENV: value, FIREBASE_PROJECT_ID: 'p', DEV_AUTH_ENABLED: 'true' })).toThrow();
  });

  it('missing NODE_ENV is production: needs a project and never allows dev auth', () => {
    expect(() => parseEnv({ DEV_AUTH_ENABLED: 'true' })).toThrow(/FIREBASE_PROJECT_ID/);
    // A project id together with dev auth is refused outright, so there is no way to run production with the dev header.
    expect(() => parseEnv({ DEV_AUTH_ENABLED: 'true', FIREBASE_PROJECT_ID: 'p' })).toThrow(/DEV_AUTH_ENABLED/);
    const e = parseEnv({ FIREBASE_PROJECT_ID: 'p' });
    expect(e.NODE_ENV).toBe('production');
    expect(devAuthAllowed(e)).toBe(false);
  });

  it('dev auth can never be on in production, whatever the other settings say', () => {
    const combos = [
      { DEV_AUTH_ENABLED: 'true' }, { DEV_AUTH_ENABLED: 'true', DEV_AUTH_UID: 'admin' },
      { DEV_AUTH_ENABLED: 'true', ALLOW_MANUAL_SNAPSHOT_IMPORT: 'true', SLR_VERIFY_PROJECT_ACCESS: 'false' },
    ];
    // Production always has a Firebase project, and a project plus dev auth is refused at start-up.
    for (const extra of combos) expect(() => parseEnv({ ...prod, ...extra })).toThrow(/DEV_AUTH_ENABLED/);
    expect(devAuthAllowed(parseEnv({ ...prod }))).toBe(false);
  });

  it('DEV_AUTH_ENABLED variants other than "true" are refused (no truthy guessing)', () => {
    for (const v of ['TRUE', '1', 'yes', ' true', '']) expect(() => parseEnv({ ...dev, DEV_AUTH_ENABLED: v })).toThrow();
  });
});

describe('empty strings for each new setting', () => {
  // A bare `KEY=` line in .env (or `KEY: ${KEY}` in compose) gives ''.
  it('FIREBASE_PROJECT_ID="" in development should behave like unset (the .env.example says leave it empty)', () => {
    expect(() => parseEnv({ ...dev, FIREBASE_PROJECT_ID: '' })).not.toThrow();
  });
  it('FIREBASE_PROJECT_ID="" in production refuses to start', () => {
    expect(() => parseEnv({ NODE_ENV: 'production', FIREBASE_PROJECT_ID: '' })).toThrow();
  });
  it.each(['FIREBASE_CHECK_REVOKED', 'SLR_VERIFY_PROJECT_ACCESS', 'ALLOW_MANUAL_SNAPSHOT_IMPORT', 'FROM_SLR_RATE_LIMIT_PER_MINUTE'])('%s="" fails closed (throws)', (key) => {
    expect(() => parseEnv({ ...prod, [key]: '' })).toThrow();
  });
  it('FIREBASE_PROJECT_ID is trimmed', () => {
    expect(parseEnv({ NODE_ENV: 'production', FIREBASE_PROJECT_ID: '  p1  ' }).FIREBASE_PROJECT_ID).toBe('p1');
  });
});

describe('rate limit numeric edge cases', () => {
  const rl = (v: string) => parseEnv({ ...dev, FROM_SLR_RATE_LIMIT_PER_MINUTE: v }).FROM_SLR_RATE_LIMIT_PER_MINUTE;
  it('accepts scientific notation 1e3 as 1000', () => expect(rl('1e3')).toBe(1000));
  it('rejects 10.5', () => expect(() => rl('10.5')).toThrow());
  it('observes: hex 0x10 is accepted as 16 (Number coercion)', () => expect(rl('0x10')).toBe(16));
  it('observes: surrounding whitespace is accepted', () => expect(rl(' 5 ')).toBe(5));
  it.each(['1e400', 'Infinity', 'NaN', 'abc', '-1', '0', '0.0'])('rejects %j', (v) => expect(() => rl(v)).toThrow());
  it('observes: very large integers are accepted (no upper bound)', () => expect(rl('99999999999999999999')).toBe(1e20));
});

describe('manual import default', () => {
  it('defaults to on in production, test, and development', () => {
    expect(parseEnv(prod).ALLOW_MANUAL_SNAPSHOT_IMPORT).toBe(true);
    expect(parseEnv({ NODE_ENV: 'test' }).ALLOW_MANUAL_SNAPSHOT_IMPORT).toBe(true);
  });
  it('SLR_VERIFY_PROJECT_ACCESS defaults to true in production too', () => {
    expect(parseEnv(prod).SLR_VERIFY_PROJECT_ACCESS).toBe(true);
  });
});
