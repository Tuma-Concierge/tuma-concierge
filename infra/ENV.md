# Env matrix (names only)

Per environment: `local` | `preview` | `staging` | `prod`

## Database
- `DATABASE_URL`

## MoMo (MTN / Airtel)
- `MOMO_BASE_URL`
- `MOMO_SUBSCRIPTION_KEY`
- `MOMO_API_USER`
- `MOMO_API_KEY`
- `MOMO_TARGET_ENV` (`sandbox` | `production`)
- `MOMO_CALLBACK_URL`

## Maps
- `MAPS_API_KEY` (server)
- Public map key only if required; restrict by HTTP referrer

## Storage (R2)
- Prefer Worker R2 binding; optional S3-compat keys if needed

## WebRTC TURN
- `TURN_URLS`
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

## Push
- `PUSH_VAPID_PUBLIC_KEY`
- `PUSH_VAPID_PRIVATE_KEY`
- `PUSH_SUBJECT`

## App
- `JWT_SECRET` / `SESSION_SECRET`
- `CORS_ORIGINS`

Do not paste secret values into chat, issues, or commits.
