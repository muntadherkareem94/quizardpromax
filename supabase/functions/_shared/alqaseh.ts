// Al-Qaseh payment adapter (Sandbox or Production). Server-side only.
// Official API: https://docs.alqaseh.com/api
import { createClient } from 'npm:@supabase/supabase-js@2';

const SANDBOX_API = 'https://api-test.alqaseh.com/v1';
const SANDBOX_PAYMENT_PAGE = 'https://pay-test.alqaseh.com/pay/';

// Leave existing deployments in Sandbox unless production is explicitly configured.
// Live endpoints must be confirmed by Al-Qaseh and supplied as server-side secrets.
function gatewayConfig() {
  const environment = (Deno.env.get('ALQASEH_ENVIRONMENT') || 'sandbox').toLowerCase();
  if (environment === 'sandbox') {
    return { api: SANDBOX_API, hostedPage: SANDBOX_PAYMENT_PAGE };
  }
  if (environment !== 'production') {
    throw new Error('Invalid Al-Qaseh environment');
  }
  const api = Deno.env.get('ALQASEH_PRODUCTION_API_URL');
  const hostedPage = Deno.env.get('ALQASEH_PRODUCTION_PAY_URL');
  if (!api || !hostedPage) {
    throw new Error('Production gateway URLs are not configured');
  }
  const apiUrl = new URL(api);
  const pageUrl = new URL(hostedPage);
  const isProviderHost = (hostname: string) =>
    hostname === 'alqaseh.com' || hostname.endsWith('.alqaseh.com');
  if (
    apiUrl.protocol !== 'https:' || pageUrl.protocol !== 'https:' ||
    !isProviderHost(apiUrl.hostname) || !isProviderHost(pageUrl.hostname) ||
    apiUrl.hostname.includes('test') || pageUrl.hostname.includes('test') ||
    !pageUrl.pathname.startsWith('/pay/')
  ) {
    throw new Error('Invalid Al-Qaseh production endpoint configuration');
  }
  if (!pageUrl.pathname.endsWith('/')) pageUrl.pathname += '/';
  return { api: apiUrl.href.replace(/\/$/, ''), hostedPage: pageUrl.href };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPACT_UUID = /^[0-9a-f]{32}$/i;

// Al-Qaseh UAT returns order_id as 32 hex chars; Quizard stores UUIDs with hyphens.
function normalizeOrderId(value: string): string {
  const compact = value.replaceAll('-', '').toLowerCase();
  if (!COMPACT_UUID.test(compact)) throw new Error('Invalid merchant order reference');
  return [compact.slice(0, 8), compact.slice(8, 12), compact.slice(12, 16),
    compact.slice(16, 20), compact.slice(20)].join('-');
}

function credentials() {
  const clientId = Deno.env.get('ALQASEH_CLIENT_ID');
  const clientSecret = Deno.env.get('ALQASEH_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('Al-Qaseh credentials not configured');
  return 'Basic ' + btoa(clientId + ':' + clientSecret);
}

async function providerRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', credentials());
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  const res = await fetch(gatewayConfig().api + path, { ...init, headers });
  const raw = await res.text();
  let payload: any = {};
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { payload = raw; }
  if (!res.ok) {
    // A 4xx response usually means the provider rejected a request field,
    // not that Supabase itself failed. Log ONLY diagnostic fields.
    // Never log authorization headers, keys, tokens or card information.
    const diagnostic = payload && typeof payload === 'object' ? {
      err: payload.err,
      error_code: payload.error_code,
      reference_code: payload.reference_code,
      message: payload.message,
      error: typeof payload.error === 'string' ? payload.error : undefined,
      errors: payload.errors
    } : null;
    // Some 400 responses are strings or have a different JSON envelope.
    // Record only a short, redacted diagnostic; never expose API credentials.
    const redactedExcerpt = raw
      .replace(/(authorization|password|client_secret|secret|api_key|cardnumber|cvv)\\?["'=:\s]+[^,}\s"]+/gi, '$1:[redacted]')
      .replace(/[A-Za-z0-9_+\/=\-]{28,}/g, '[redacted]')
      .slice(0, 350);
    console.error('Al-Qaseh API rejected request', JSON.stringify({
      http_status: res.status,
      payload_type: Array.isArray(payload) ? 'array' : typeof payload,
      response_keys: payload && typeof payload === 'object'
        ? Object.keys(payload).slice(0, 15) : [],
      details: diagnostic,
      response_excerpt: redactedExcerpt
    }).slice(0, 1600));
    throw new Error('Payment gateway rejected the request (HTTP ' + res.status + ')');
  }
  return payload;
}

export async function createAlqasehPayment(input: {
  orderId: string; amountIQD: number; description: string;
  redirectUrl: string; webhookUrl?: string;
}) {
  if (!UUID.test(input.orderId) ||
      !Number.isSafeInteger(input.amountIQD) || input.amountIQD <= 0 ||
      new URL(input.redirectUrl).protocol !== 'https:' ||
      (input.webhookUrl && new URL(input.webhookUrl).protocol !== 'https:')) {
    throw new Error('Invalid payment request');
  }
  const result = await providerRequest('/egw/payments/create', {
    method: 'POST',
    body: JSON.stringify({
      amount: input.amountIQD,
      country: 'IQ',
      currency: 'IQD',
      // Provider UAT currently rejects a varchar(32) overflow.
      // Keep Quizard's internal UUID unchanged; use its 32 hex digits
      // as the provider order reference.
      description: input.description.slice(0, 30),
      order_id: input.orderId.replaceAll('-', ''),
      redirect_url: input.redirectUrl,
      ...(input.webhookUrl ? { webhook_url: input.webhookUrl } : {}),
      transaction_type: 'Retail',
      token_expiry_in_hour: 1
    })
  });
  if (typeof result.payment_id !== 'string' ||
      !result.payment_id ||
      typeof result.token !== 'string' || !result.token) {
    throw new Error('Gateway did not return a valid payment reference');
  }
  const { hostedPage } = gatewayConfig();
  const checkout = new URL(encodeURIComponent(result.token), hostedPage);
  if (checkout.protocol !== 'https:' ||
      checkout.hostname !== new URL(hostedPage).hostname) {
    throw new Error('Invalid Al-Qaseh checkout URL');
  }
  return { paymentId: result.payment_id, checkoutUrl: checkout.href };
}

export async function settleAlqasehPayment(
  admin: ReturnType<typeof createClient>, orderId: string
): Promise<'paid'|'failed'|'pending'> {
  const requestId = normalizeOrderId(orderId);
  const { data: invoice, error: fetchError } = await admin
    .from('qz_card_checkouts').select('*')
    .eq('request_id', requestId).maybeSingle();
  if (fetchError) throw fetchError;
  if (!invoice || invoice.provider !== 'alqaseh' || !invoice.provider_payment_id) {
    throw new Error('Unknown payment reference');
  }
  if (invoice.status === 'paid') return 'paid';

  // The official payment history API supports an exact payment_id filter.
  // Unlike /payments/{id}, this does not assume that payment_id is an
  // internal numeric payment-context ID.
  const history = await providerRequest(
    '/egw/payments/history?payment_id=' +
    encodeURIComponent(invoice.provider_payment_id) + '&limit=10'
  );
  const actual = Array.isArray(history)
    ? history.find(item => String(item?.payment_id) === invoice.provider_payment_id)
    : null;
  if (!actual) throw new Error('Payment not found in merchant history');

  if (String(actual.payment_id) !== invoice.provider_payment_id ||
      normalizeOrderId(String(actual.order_id)) !== invoice.request_id ||
      actual.currency !== 'IQD' ||
      Number(actual.amount) !== Number(invoice.amount_iqd)) {
    throw new Error('Verified gateway payment does not match order');
  }

  const status = String(actual.payment_status || '').toLowerCase();
  if (status === 'succeeded') {
    // An early webhook may arrive before the new payment ID is saved.
    if (invoice.status !== 'pending') return 'pending';

    const { data: upgrade, error: upgradeError } = await admin
      .from('qz_plan_upgrade_orders').select('request_id')
      .eq('request_id', requestId).maybeSingle();
    if (upgradeError) throw upgradeError;
    const fn = upgrade ? 'qz_confirm_plan_upgrade' : 'qz_confirm_card_payment';
    const { error: confirmationError } = await admin.rpc(fn, {
      p_request_id: requestId,
      p_payment_id: invoice.provider_payment_id,
      p_amount_iqd: invoice.amount_iqd,
      p_currency: 'IQD'
    });
    if (confirmationError) throw confirmationError;
    return 'paid';
  }

  if (['failed', 'declined', 'expired', 'revoked', 'duplicated'].includes(status)) {
    const { error: markError } = await admin
      .from('qz_card_checkouts').update({ status: 'failed' })
      .eq('request_id', requestId).in('status', ['created', 'pending']);
    if (markError) throw markError;
    const { error: upgradeError } = await admin
      .from('qz_plan_upgrade_orders').update({ status: 'failed' })
      .eq('request_id', requestId).in('status', ['created', 'pending']);
    if (upgradeError) throw upgradeError;
    return 'failed';
  }
  return 'pending';
}
