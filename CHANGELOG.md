# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

To release: add the version's section below, bump `version` in `package.json`, merge, then push a `vX.Y.Z` tag on the release commit. The `release` workflow publishes the GitHub release with that section as its notes.

## [Unreleased]

### New
- Alerts that need a human go to `ALERT_TOPIC_ID` (defaults to `LOG_TOPIC_ID`) (#75)
- Clearer errors from the PayHere API

### Changed
- Sales and purchases are linked to their bot transfers by payment hash (#71)
- One-time buys show "Sats Purchase" on the PayHere checkout
- Settlement no longer looks payments up with PayHere's API
- README updated; licensed under AGPL-3.0 (#72)

## [2.0.1] - 2026-11-20

## New
- **Manage admins from the dashboard**: `GET /admin/admins` lists admins and `POST /admin/admins` adds one (password at least 12 characters; 409 for a duplicate email) (#66)
- **Flat bank charge on sales**: each sale now deducts `SELL_BANK_CHARGE_LKR` (default Rs.30) after the fee. It is stored on the order as `bank_charge_lkr`, and `amount_lkr` is gross minus fee minus bank charge (#67)

### Upgrading
- 1 new migration: `20261130000000_add_sell_bank_charge`, applied on startup in production
- New optional env var `SELL_BANK_CHARGE_LKR` (0–1000, 2 decimal places; empty means 30, set `0` for no charge)

## [2.0.0] - 2026-11-20

The 2.0 release: selling sats for LKR, one-time buys, P2P sends, an admin dashboard API, server-side sessions with Telegram web login, a single BTC/LKR price everywhere, and a large round of payment and settlement hardening. 211 files changed since the previous `main`.

### Highlights

#### New
- **Sell sats for LKR** via CeyPay, paid to an admin-verified bank account. The user approves the debit through the bot's collect API; payouts, refunds and stuck orders are tracked by status, with retries and `NEEDS_REVIEW` alerts (#41, #47, #54)
- **One-time BTC buys** through a one-off PayHere checkout, with per-buy, daily and hourly limits, order expiry and holds for late or duplicate payments (#43)
- **P2P sends** between Bitcoin Deepa users, relayed to the bot (`/p2p/*`), and **Bitcoin Deepa @usernames** to resolve recipients (#54, #56, #60)
- **Server-side sessions** (`user_session`) with **Log In with Telegram (OIDC + PKCE)** for the web app and an initData exchange for the Mini App; legacy JWTs can read but not spend (#62)
- **Admin dashboard API**: Better Auth sign-in, analytics, transactions, members and bank-account reviews (#38, #39, #40, #41)
- **One BTC/LKR price**: Ceylon Cash BTC/USD × CeyPay USDT/LKR, with a 1-minute rate log used as a short fallback; CoinMarketCap is display-only (#46, #48, #52)
- **Ed25519-signed bot API** with approval polling, same-memo retries and the deposit callback (#49, #61)
- History: sales in `/transaction/list`, settlement and sale transfers marked in bot history, user avatar seed (#53, #57, #58, #59)
- Unit and e2e test suites with CI (#37)

#### Fixes and hardening
- Security, payment and code-quality review: subscription owner taken from the server-side order (not `custom_1`), Didit webhook replay and timestamp checks, settlement safety and alerting, config validation at startup (#36)
- Sell payout gaps (double pay, stuck order, double claim, deadlock), chargeback during settlement, 3-hourly reminders for items waiting on a human (#47)
- Each payment keeps its transfer memo across the release cutover, so earlier sends are still deduped (#65)
- One-line CMC errors with a failure cache, Telegram 429 backoff (#50)
- Bun lockfile, axios upgrade (#26, #35); Redis credential removed from docs (#34)

#### Developer
- Pending migrations run on startup in production (#44)
- External API calls and JSON log lines logged in development (#51)
- `payhere_order` renamed to `buy_order` (#55)

### Upgrading
- **18 new migrations** (`20261117…` to `20261129…`). Production applies them on startup.
- **New env vars required in production** (the app refuses to boot without them): `APP_URL`, `TELEGRAM_OIDC_CLIENT_ID`, `TELEGRAM_OIDC_CLIENT_SECRET`, `TRUST_PROXY`, `BASE_URL`, `BETTER_AUTH_SECRET`, `ADMIN_APP_URL`, `DIDIT_WEBHOOK_SECRET`, `CEYPAY_API_URL`, `CEYPAY_API_KEY_ID`, `CEYPAY_API_SECRET`, `BITCOINDEEPA_API_URL`, `BITCOINDEEPA_WALLET_ID`, `BITCOINDEEPA_PRIVATE_KEY_PEM` (Ed25519). With `SELL_ENABLED=true`, also `CEYPAY_WEBHOOK_PUBLIC_KEY` and the `R2_*` settings. See `.env.template`.
- **Deploy with the matching bot build**: the bot rejects V1-signed `/p2p/*` calls, and sends are Ed25519-signed.
- Register `BASE_URL/auth/telegram/callback` in BotFather for web login, and create the first dashboard admin with `bun run admin:create`.

[Unreleased]: https://github.com/bitcoindeepa/app-backend/compare/v2.0.1...HEAD
[2.0.1]: https://github.com/bitcoindeepa/app-backend/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/bitcoindeepa/app-backend/compare/5b13b46...v2.0.0
