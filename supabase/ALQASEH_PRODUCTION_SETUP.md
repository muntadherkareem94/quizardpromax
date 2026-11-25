# Al-Qaseh production activation checklist

This branch prepares the existing direct Al-Qaseh integration for both sandbox and production. It **does not** change the live payment environment until the server is explicitly configured.

## Before the switch
- Obtain Al-Qaseh confirmation that the merchant account and settlement wallet are active and approved for production (not a temporary wallet).
- Confirm the official production API base URL and hosted-payment-page URL with Al-Qaseh. Do not assume URLs from unofficial packages.
- Put the production Client ID and Client Secret into Supabase Edge Function secrets, **never** in GitHub or public JavaScript.
- Set the following Supabase secrets:
  - `ALQASEH_ENVIRONMENT=production`
  - `ALQASEH_PRODUCTION_API_URL=<provider-confirmed HTTPS API v1 base URL>`
  - `ALQASEH_PRODUCTION_PAY_URL=<provider-confirmed HTTPS hosted checkout /pay/ URL>`
  - `ALQASEH_CLIENT_ID=<production client ID>`
  - `ALQASEH_CLIENT_SECRET=<production client secret>`
- Confirm `QUIZARD_RETURN_URL=https://quizardiq.com/payment-result.html`, HTTPS.
- Redeploy **all** Al-Qaseh Edge Functions that import `_shared/alqaseh.ts`: `alqaseh-start-checkout`, `alqaseh-start-book-checkout`, `alqaseh-start-plan-upgrade`, `alqaseh-verify-payment`, `alqaseh-payment-webhook`.
- Check deployed webhook function is public to Al-Qaseh (`verify_jwt = false`); it validates the payment via the authenticated payment-history API.
- Test a low-value real payment only after merchant activation; verify order ID, amount, currency, settlement status, subscription activation and refunds.

## Rollback
Set `ALQASEH_ENVIRONMENT=sandbox` and restore sandbox API credentials, then redeploy the same functions. Do not use production credentials against sandbox endpoints.

## Important
The production URLs were not confirmed from official documentation during preparation; configuration deliberately requires explicit URLs. No live API keys were committed. Production data must not be inserted into HTML, GitHub, frontend JS, or test logs.
