# Telegram login — setup

Everything the flow needs that is **not** in this repository: the BotFather
registration, the Flutter integration, and the platform manifest entries.

The backend half is done and tested. Design rationale is in
[../ARCHITECTURE.md](../ARCHITECTURE.md) §8; the wire contract is
[API_CONTRACTS.md](API_CONTRACTS.md) §1a.

---

## 1. Why this flow and not the others

Four ways to sign in with Telegram exist. This is why we use the third.

| Approach | Verdict |
|---|---|
| **Login Widget (legacy)** — iframe + HMAC over `data_check_string` | Rejected. Browser-only, needs `/setdomain`, and Telegram has archived the docs in favour of OIDC. |
| **Mini App `initData`** | Rejected. Only works inside the Telegram client; this is a standalone mobile app. |
| **Telegram Login, OpenID Connect** ← ours | Official native SDKs, app-to-app, an `id_token` we can verify cryptographically, and a **Telegram-verified phone number**. |
| **Bot deep link** — `t.me/<bot>?start=<nonce>` then poll | Rejected as the primary path. Needs an inbound webhook or polling loop, and the phone requires a second `request_contact` round trip. Kept in mind as a fallback: it needs no BotFather URL registration at all. |

The decisive point was the `phone` scope. §4.1 makes the platform's identity a phone
number, and BR-09 is about revealing it to employers; OIDC hands us
`phone_number_verified` and keeps that model intact. Every other option would have
made the phone a separate, optional step.

---

## 2. BotFather

Same bot as file storage, or a separate one — the backend only needs its **numeric
id** for login, and its **token** for files.

1. Open [@BotFather](https://t.me/botfather) → your bot → **Login Widget**.
2. Add the **Allowed URLs**. Telegram will only redirect to a pre-registered URL, so
   this list is the login's security boundary.
   - Android: `https://app<androidAppId>-login.tg.dev/tglogin`
   - iOS: `https://app<iosAppId>-login.tg.dev`
   - The `tg.dev` app-link domains are Telegram's own, so no domain of ours has to
     be verified for App Links / Universal Links.
   - Custom-scheme fallbacks (`headhunter://telegram-login`) also work; the SDK
     READMEs give the current recommended patterns.
3. Note the **Client ID** (the bot id — the part of the bot token before the colon)
   and the **Client Secret**.
4. Leave the signing algorithm at **RS256**, or use ES256. **Not EdDSA or ES256K**:
   those restrict the token to the `openid` scope, so it could not carry the phone
   number.

Set on the backend:

```sh
TELEGRAM_LOGIN_BOT_ID=1234567890   # numeric bot id; this is the id_token audience
```

The Client Secret is **not** needed by this backend — the SDK performs the code
exchange with PKCE, and we verify the resulting `id_token`. It becomes necessary only
if a future client sends the raw `code` for a server-side exchange instead.

---

## 3. Flutter

[`telegram_login`](https://pub.dev/packages/telegram_login) wraps both official SDKs.
It is small (5 likes, ~600 downloads at the time of writing), so read its source
before depending on it — or call the native SDKs through a thin platform channel of
our own. It returns `result.idToken`, which is exactly what our endpoint wants.

```dart
final telegramLogin = TelegramLogin();

await telegramLogin.configure(
  const TelegramLoginConfiguration(
    clientId: '1234567890',                        // the numeric bot id
    redirectUri: 'https://app12345-login.tg.dev',  // must match BotFather exactly
    // `phone` is not optional in practice: the server refuses a login without a
    // verified phone number, because BR-09 contact exposure has nothing to reveal.
    scopes: ['openid', 'profile', 'phone'],
  ),
);

final result = await telegramLogin.login();

// Post it straight away - the server accepts a token for five minutes from its
// `iat`, not until `exp`. Never cache one.
final tokens = await api.post('/auth/telegram', {'idToken': result.idToken});
```

`x-lang` is already on every request from the interceptor stack, and it becomes the
new account's stored locale — so nothing extra is needed for language.

After a successful call, `isNewUser` decides the route: role selection (§2.3) for a
new account, home screen otherwise.

### Android

`android/app/src/main/AndroidManifest.xml`, inside the launch activity:

```xml
<intent-filter android:autoVerify="true">
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="https" android:host="app12345-login.tg.dev" />
</intent-filter>
```

Minimum API 23. Note `applicationId` is `com.headhunter.app`, with `.dev` and
`.staging` suffixes per flavour — **each variant is a different app id, so each needs
its own registered redirect URI** in BotFather.

### iOS

Either an **Associated Domains** capability (`applinks:app12345-login.tg.dev`) for a
Universal Link, or a `CFBundleURLTypes` entry for the custom-scheme fallback.
Minimum iOS 15.

### When Telegram is not installed

The SDK falls back to a web sheet (`ASWebAuthenticationSession` on iOS), so the flow
still completes. Worth testing explicitly on a device without Telegram — it is the
path a first-time user is most likely to hit.

---

## 4. What the backend does with the token

In `TelegramOidcService`, all four of these must pass:

1. **Signature**, against `https://oauth.telegram.org/.well-known/jwks.json`.
2. **Issuer** is exactly `https://oauth.telegram.org`.
3. **Audience** is our bot id. This is the check that matters most: a genuine, valid
   Telegram token issued for somebody else's application must not sign anyone in
   here, and this is the only thing preventing it.
4. **Age** — `iat` within `TELEGRAM_ID_TOKEN_MAX_AGE_SECONDS` (default 300), so a
   captured token is dead long before `exp`.

Then `AuthService.completeTelegramLogin` resolves the account in one transaction:
known Telegram id → sign in; unknown id but a **verified** phone matching an
unclaimed account → link it, with an audit row; otherwise → create.

Only a phone Telegram reports as `phone_number_verified` is ever matched on. An
unverified value would let anyone claim an existing account by naming its number.

---

## 4a. Verified against the live services, 2026-08-05

With the real credentials configured:

| Check | Result |
|---|---|
| `getMe` with `TELEGRAM_BOT_TOKEN` | ok — bot `@uzhh_robot`, id `8565299674` |
| `TELEGRAM_LOGIN_BOT_ID` == that bot id | matches |
| OIDC discovery document | issuer, endpoints, JWKS URL and scopes all as assumed |
| JWKS | 4 keys: `oidc-1` RS256, `oidc-es256-1` ES256, `oidc-eddsa-1` EdDSA, `oidc-es256k-1` ES256K |
| File storage round trip | `sendDocument` → `getFile` → download → **SHA-256 matched**; test message deleted |

**Found by that check, and it would have blocked every login:** the discovery document
does not advertise `phone_number_verified`, but the verifier required it to be `true`.
Fixed — a `phone_number` is now treated as verified unless explicitly `false`.

**Not verifiable from the server side:** whether the BotFather Allowed URLs are
registered. Telegram's `/auth` endpoint does not report it in a way a server-side
probe can read, so it surfaces on the first real attempt from a device. If the
redirect URI is missing or does not match exactly, the SDK never returns a token —
the failure is on the client, before our API is called at all. Distinguish it from a
backend problem that way: no request in our logs means the redirect URI, not us.

## 5. Testing without a real bot

`telegram-login.int.spec.ts` generates an RSA keypair, serves it from a local JWKS
endpoint and mints genuinely signed tokens, so the real verification path runs — key
selection by `kid`, audience, issuer, age window and all. 22 cases, including forged
signatures, token substitution across bots, and a stale token whose `exp` is still
valid.

To drive the flow over HTTP against a stub, point the API at a local key set:

```sh
TELEGRAM_JWKS_URL=http://127.0.0.1:3004/jwks.json
```

`http` is accepted outside production only. In production the scheme must be https —
signing keys fetched over plaintext can be substituted, which forges every login.

---

## 6. Turning phone + OTP back on

It was not deleted. `OTP_LOGIN_ENABLED=true` restores `/auth/otp/send`,
`/auth/otp/resend` and `/auth/otp/verify`; the schema, service and integration tests
were never removed. Both paths issue sessions through the same `AuthService`, and an
account can hold both credentials — a Telegram login carrying a verified phone links
to the account the OTP flow created rather than duplicating it.
