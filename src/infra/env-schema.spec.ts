import { envSchema } from './env-schema';

/**
 * The production refusals (MT-003).
 *
 * Four settings are refused outright when `NODE_ENV=production` rather than
 * trusted to a deploy checklist, and until now **none of them was tested**. A
 * boot check nobody exercises is a boot check that can stop working silently:
 * a `.when()` typo, a renamed variable, a Joi upgrade that changes how `valid`
 * composes with `default`, and the container starts happily with the hole open.
 *
 * MT-003 is what that costs. `MODERATION_ENABLED=false` was found on the
 * deployed API by three consecutive audits, so a *warning* is demonstrably not
 * enough — which is the argument for refusing the boot, and for this file.
 */

/** The minimum that validates, so a test only has to state what it is about. */
const base = {
  DB_HOST: 'localhost',
  DB_NAME: 'jobbridge',
  DB_USER: 'jobbridge',
  DB_PASSWORD: 'secret',
  JWT_SECRET: 'x'.repeat(32),
  TOKEN_HASH_PEPPER: 'y'.repeat(32),
  TELEGRAM_LOGIN_BOT_ID: '123456',
  TELEGRAM_BOT_TOKEN: '123456:abc',
  TELEGRAM_STORAGE_CHAT_ID: '-1001234567890',
};

function validate(env: Record<string, unknown>) {
  return envSchema.validate({ ...base, ...env }, { abortEarly: false });
}

describe('the schema accepts a development instance', () => {
  it('with every escape hatch open, which is what a laptop needs', () => {
    // None of the refusals below may fire outside production: an instance with
    // no administrator has to be able to turn review off, and a developer with
    // no SMS provider has to be able to read the code.
    const { error } = validate({
      NODE_ENV: 'development',
      MODERATION_ENABLED: false,
      EMPLOYER_VERIFICATION_ENABLED: false,
      OTP_ECHO_IN_RESPONSE: true,
      OTP_STATIC_CODE: '666666',
    });

    expect(error).toBeUndefined();
  });

  it('and defaults both review flags to on', () => {
    const { error, value } = validate({});

    expect(error).toBeUndefined();
    expect(value.MODERATION_ENABLED).toBe(true);
    expect(value.EMPLOYER_VERIFICATION_ENABLED).toBe(true);
  });
});

describe('production refuses the settings that would unenforce a rule', () => {
  const production = { NODE_ENV: 'production' };

  it('MODERATION_ENABLED=false — MT-003', () => {
    // Off, a vacancy becomes discoverable with no administrator decision, so
    // §6.4, BR-04, BR-12, UAT-05 and UAT-11 are unenforced while the moderation
    // screen still exists and looks like it is doing something.
    const { error } = validate({ ...production, MODERATION_ENABLED: false });

    expect(error?.message).toContain('MODERATION_ENABLED must be true');
  });

  it('EMPLOYER_VERIFICATION_ENABLED=false', () => {
    const { error } = validate({
      ...production,
      EMPLOYER_VERIFICATION_ENABLED: false,
    });

    expect(error?.message).toContain(
      'EMPLOYER_VERIFICATION_ENABLED must be true',
    );
  });

  it('OTP_ECHO_IN_RESPONSE=true, which hands any caller a login code', () => {
    const { error } = validate({ ...production, OTP_ECHO_IN_RESPONSE: true });

    expect(error?.message).toContain('OTP_ECHO_IN_RESPONSE must be false');
  });

  it('a non-empty OTP_STATIC_CODE, which is a master key to every account', () => {
    const { error } = validate({ ...production, OTP_STATIC_CODE: '666666' });

    expect(error?.message).toContain('OTP_STATIC_CODE');
  });

  it('and reports every one of them at once', () => {
    // `abortEarly: false`, so somebody fixing a refused deployment sees the
    // whole list rather than one variable per restart.
    const { error } = validate({
      ...production,
      MODERATION_ENABLED: false,
      EMPLOYER_VERIFICATION_ENABLED: false,
      OTP_ECHO_IN_RESPONSE: true,
    });

    expect(error?.details).toHaveLength(3);
  });

  it('accepts a production instance with all four set safely', () => {
    const { error } = validate({
      ...production,
      MODERATION_ENABLED: true,
      EMPLOYER_VERIFICATION_ENABLED: true,
      OTP_ECHO_IN_RESPONSE: false,
      OTP_STATIC_CODE: '',
      TELEGRAM_JWKS_URL: 'https://oauth.telegram.org/.well-known/jwks.json',
    });

    expect(error).toBeUndefined();
  });
});
