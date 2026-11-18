# Quizard — Al-Qaseh UAT integration

Quizard's normal purchase buttons on the **main app** now use Al-Qaseh's hosted sandbox payment page. This is a real end-to-end integration using the gateway's UAT environment, **not a production-money integration**.

## Runtime requirements

The Supabase project must have these server-only secrets:
- `ALQASEH_CLIENT_ID`
- `ALQASEH_CLIENT_SECRET`
- `QUIZARD_RETURN_URL` — the main Quizard HTTPS `/payment-result.html` URL, used by the existing Qi integration and reused by Al-Qaseh.

Do not add any API secrets to the website. **`ALQASEH_SANDBOX_TEST_USER_ID` is not needed** — UAT purchases are available to signed-in users because Quizard is currently a test deployment. Do not treat these as genuine paid subscriptions.

## Purchase paths

1. New Premium/Platinum subscription: `alqaseh-start-checkout`
2. Standalone book purchase: `alqaseh-start-book-checkout`
3. Upgrade/change plan with remaining balance credit: `alqaseh-start-plan-upgrade`
4. Gateway notifications: `alqaseh-payment-webhook`
5. Signed-in receipt retry/reconciliation: `alqaseh-verify-payment`

All of these share `_shared/alqaseh.ts`.

## Verification

- The backend reads current plan/book prices from Supabase, never from the browser.
- Al-Qaseh's UAT API returns a 32-hex-character order ID; the app's internal payment UUID remains a normal 36-character UUID.
- The provider payment ID and order ID, amount and IQD currency must match the invoice.
- The backend verifies merchant payment history with Basic Auth before invoking the existing service-role-only `qz_confirm_card_payment` or `qz_confirm_plan_upgrade` RPC.
- Webhooks are untrusted; the browser redirect is untrusted; duplicate successful notifications are safe.
- Old Qi records retain `provider='qi'` and can still be displayed.

## Deployment

1. Apply the SQL in `supabase/alqaseh-provider.sql` (already applied to the active project).
2. Deploy all five Edge Functions. User-facing functions require authenticated Supabase JWTs; the webhook cannot require a JWT.
3. Merge GitHub PR #2 into `main`, allowing Netlify to deploy the main application.
4. Test the actual site with a test Quizard account, purchasing a plan/book and checking `qz_card_checkouts` and related entitlement tables.

## Important UAT limitation

The provider's public UAT test card may produce `paid` records and unlock Quizard books/plans, **without transferring real funds**. Do not open paid products to real customers or accept genuine payment until merchant-specific production credentials and live API/checkout domains have been issued and independently tested. The isolated UAT smoke-test page and callback code have been removed from `main`.
