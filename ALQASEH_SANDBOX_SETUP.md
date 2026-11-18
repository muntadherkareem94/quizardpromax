# Al-Qaseh Sandbox migration for Quizard

**Status: integration draft — do not deploy to production payment traffic until Sandbox tests pass.**

## Gateway documentation
- [Official API](https://docs.alqaseh.com/api)
- [Hosted payment flow](https://docs.alqaseh.com/payment-integration-overview)
- The sandbox API endpoint is `https://api-test.alqaseh.com/v1`.
- Hosted test checkout is `https://pay-test.alqaseh.com/pay/{token}`.

## Supabase setup (test only)

1. Apply `supabase/alqaseh-provider.sql` in the Supabase SQL editor. All prior checkouts become `provider='qi'`; existing entitlements stay unchanged.
2. Set **Supabase Edge Function secrets** `ALQASEH_CLIENT_ID` and `ALQASEH_CLIENT_SECRET` to the sandbox merchant credentials. The official docs contain public sandbox credentials. **Never paste live credentials into GitHub or frontend files.**
3. Keep `QUIZARD_RETURN_URL` pointed to the HTTPS `payment-result.html` on your test host.
4. Deploy these new functions (all of them use `../_shared/alqaseh.ts`):
   - `alqaseh-start-checkout` — user JWT required *inside handler*
   - `alqaseh-start-book-checkout` — user JWT required *inside handler*
   - `alqaseh-start-plan-upgrade` — user JWT required *inside handler*
   - `alqaseh-verify-payment` — user JWT + order ownership required
   - `alqaseh-payment-webhook` — public webhook; independently checks the merchant API
5. Because webhooks come from Al-Qaseh without a Supabase JWT, deploy the webhook with `verify_jwt=false`. The four browser-called functions currently authenticate in the handler; they may be deployed with `verify_jwt=false` to match the original Qi handlers, as they still reject unauthenticated users.
6. Deploy the frontend **to a test/staging site first**. Do not merge this branch onto the site used by paying users before testing.

## Test checklist

- [ ] Signed-out user cannot create a payment.
- [ ] Sandbox test card opens hosted Al-Qaseh page; book/plan price exactly matches server-side Supabase price.
- [ ] Successful payment changes `qz_card_checkouts.status` to `paid` and activates exactly one entitlement.
- [ ] Refresh/repeated webhook does **not** grant a second subscription or duplicate a book license.
- [ ] Failed/cancelled payment does **not** unlock access.
- [ ] Change of plan applies the frozen quote and unused-credit calculation correctly.
- [ ] Return page handles both `requestId` (old Qi) and `order_id` (Al-Qaseh).
- [ ] Old Qi checkout records still render and remain unchanged.

## Safety

The backend checks the gateway transaction by authenticated `GET /egw/payments/{id}`, validates merchant `order_id`, payment ID, IQD amount and currency, and only then invokes existing trusted Supabase confirmation RPCs. Browser redirect parameters and unsigned webhook payloads are **never** accepted as proof of payment. Prices and purchase eligibility remain server-side.

## Go-live prerequisites

Obtain **merchant-specific production** client ID/secret, approved production API/checkout domain names and provider confirmation of webhook setup. The code currently uses *sandbox only*. Do not change the hostnames or insert production credentials until the contract and production test plan are approved.
