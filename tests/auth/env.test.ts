import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.js';

describe('parseEnv production rules', () => {
  it('refuses to start in production without a Firebase project id', () => {
    expect(() => parseEnv({ NODE_ENV: 'production' })).toThrow(/FIREBASE_PROJECT_ID/);
  });

  it('treats a missing NODE_ENV as production, so a forgotten setting also refuses to start', () => {
    expect(() => parseEnv({})).toThrow(/FIREBASE_PROJECT_ID/);
  });

  it('rejects a blank Firebase project id in production', () => {
    expect(() => parseEnv({ NODE_ENV: 'production', FIREBASE_PROJECT_ID: '   ' })).toThrow();
  });

  it('starts in production with a project id', () => {
    expect(parseEnv({ NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'my-project' }).FIREBASE_PROJECT_ID).toBe('my-project');
  });

  it('refuses the Firebase Auth emulator outside development and test (its tokens can be forged)', () => {
    const host = 'localhost:9099';
    expect(() => parseEnv({ NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'p', FIREBASE_AUTH_EMULATOR_HOST: host })).toThrow(/FIREBASE_AUTH_EMULATOR_HOST/);
    expect(() => parseEnv({ FIREBASE_PROJECT_ID: 'p', FIREBASE_AUTH_EMULATOR_HOST: host })).toThrow(/FIREBASE_AUTH_EMULATOR_HOST/);
    expect(parseEnv({ NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'p', FIREBASE_AUTH_EMULATOR_HOST: host }).FIREBASE_PROJECT_ID).toBe('p');
    expect(parseEnv({ NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'p', FIREBASE_AUTH_EMULATOR_HOST: '  ' }).FIREBASE_PROJECT_ID).toBe('p');
  });

  it('does not require a project id in development or test', () => {
    expect(parseEnv({ NODE_ENV: 'development' }).FIREBASE_PROJECT_ID).toBeUndefined();
    expect(parseEnv({ NODE_ENV: 'test' }).FIREBASE_PROJECT_ID).toBeUndefined();
  });

  it('allows manual snapshot import outside production and blocks it in production by default', () => {
    expect(parseEnv({ NODE_ENV: 'development' }).ALLOW_MANUAL_SNAPSHOT_IMPORT).toBe(true);
    expect(parseEnv({ NODE_ENV: 'test' }).ALLOW_MANUAL_SNAPSHOT_IMPORT).toBe(true);
    expect(parseEnv({ NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'p' }).ALLOW_MANUAL_SNAPSHOT_IMPORT).toBe(false);
  });

  it('lets an explicit setting win in both directions', () => {
    expect(parseEnv({ NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'p', ALLOW_MANUAL_SNAPSHOT_IMPORT: 'true' }).ALLOW_MANUAL_SNAPSHOT_IMPORT).toBe(true);
    expect(parseEnv({ NODE_ENV: 'development', ALLOW_MANUAL_SNAPSHOT_IMPORT: 'false' }).ALLOW_MANUAL_SNAPSHOT_IMPORT).toBe(false);
  });

  it('rejects values that are not true or false instead of guessing', () => {
    expect(() => parseEnv({ NODE_ENV: 'development', ALLOW_MANUAL_SNAPSHOT_IMPORT: 'yes' })).toThrow();
    expect(() => parseEnv({ NODE_ENV: 'development', SLR_VERIFY_PROJECT_ACCESS: '1' })).toThrow();
    expect(() => parseEnv({ NODE_ENV: 'development', FIREBASE_CHECK_REVOKED: 'maybe' })).toThrow();
  });

  it('defaults to checking SLR project access and not checking revocation', () => {
    const parsed = parseEnv({ NODE_ENV: 'development' });
    expect(parsed.SLR_VERIFY_PROJECT_ACCESS).toBe(true);
    expect(parsed.FIREBASE_CHECK_REVOKED).toBe(false);
  });

  it('validates the rate limit', () => {
    expect(parseEnv({ NODE_ENV: 'development' }).FROM_SLR_RATE_LIMIT_PER_MINUTE).toBe(20);
    expect(() => parseEnv({ NODE_ENV: 'development', FROM_SLR_RATE_LIMIT_PER_MINUTE: '0' })).toThrow();
    expect(() => parseEnv({ NODE_ENV: 'development', FROM_SLR_RATE_LIMIT_PER_MINUTE: '-5' })).toThrow();
  });
});

describe('settings that cannot be combined or are left blank', () => {
  it('refuses dev auth together with a Firebase project id, in every environment', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      expect(() => parseEnv({ NODE_ENV, FIREBASE_PROJECT_ID: 'p', DEV_AUTH_ENABLED: 'true' })).toThrow(/DEV_AUTH_ENABLED/);
    }
  });

  it('treats a blank FIREBASE_PROJECT_ID as not set outside production, and still refuses to start in production', () => {
    expect(parseEnv({ NODE_ENV: 'development', FIREBASE_PROJECT_ID: '' }).FIREBASE_PROJECT_ID).toBeUndefined();
    expect(parseEnv({ NODE_ENV: 'development', FIREBASE_PROJECT_ID: '   ' }).FIREBASE_PROJECT_ID).toBeUndefined();
    expect(() => parseEnv({ NODE_ENV: 'production', FIREBASE_PROJECT_ID: '' })).toThrow(/FIREBASE_PROJECT_ID/);
  });
});
