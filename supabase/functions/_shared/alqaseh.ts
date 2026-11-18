// Al-Qaseh Sandbox payment adapter. Server-side only.
// Official API: https://docs.alqaseh.com/api
import { createClient } from 'npm:@supabase/supabase-js@2';

const API = 'https://api-test.alqaseh.com/v1';
const HOSTED_PAGE = 'https://pay-test.alqaseh.com/pay/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const res = await fetch(API + path, { ...init, headers });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Al-Qaseh API HTTP status:', res.status);
    throw new Error('Payment gateway temporarily unavailable');
  }
  return payload;
}

export async function createAlqasehPayment(input: {
  orderId: string; amountIQD: number; description: string;
  redirectUrl: string; webhookUrl: string;
}) {
  if (!UUID.test(input.orderId) ||
      !Number.isSafeInteger(input.amountIQD) || input.amountIQD <= 0 ||
      new URL(input.redirectUrl).protocol !== 'https:' ||
      new URL(input.webhookUrl).protocol !== 'https:') {
    throw new Error('Invalid payment request');
  }
  const result = await providerRequest('/egw/payments/create', {
    method: 'POST',
    body: JSON.stringify({
      amount: input.amountIQD,
      currency: 'IQD',
      description: input.description.slice(0, 250),
      order_id: input.orderId,
      redirect_url: input.redirectUrl,
      webhook_url: input.webhookUrl,
      transaction_type: 'Retail',
      token_expiry_in_hour: 1
    })
  });
  if (typeof result.payment_id !== 'string' ||
      !result.payment_id ||
      typeof result.token !== 'string' || !result.token) {
    throw new Error('Gateway did not return a valid payment reference');
  }
  const checkout = new URL(encodeURIComponent(result.token), HOSTED_PAGE);
  if (checkout.protocol !== 'https:' ||
      checkout.hostname !== 'pay-test.alqaseh.com') {
    throw new Error('Invalid Al-Qaseh checkout URL');
  }
  return { paymentId: result.payment_id, checkoutUrl: checkout.href };
}

export async function settleAlqasehPayment(
  admin: ReturnType<typeof createClient>, orderId: string
): Promise<'paid'|'failed'|'pending'> {
  if (!UUID.test(orderId)) throw new Error('Invalid order reference');
  const { data: invoice, error: fetchError } = await admin
    .from('qz_card_checkouts').select('*')
    .eq('request_id', orderId).maybeSingle();
  if (fetchError) throw fetchError;
  if (!invoice || invoice.provider !== 'alqaseh' || !invoice.provider_payment_id) {
    throw new Error('Unknown payment reference');
  }
  const sandboxTestId = Deno.env.get('ALQASEH_SANDBOX_TEST_USER_ID');
  if (!sandboxTestId || invoice.user_id !== sandboxTestId) {
    throw new Error('Sandbox payment is restricted to the designated test account');
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
      String(actual.order_id) !== invoice.request_id ||
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
      .eq('request_id', orderId).maybeSingle();
    if (upgradeError) throw upgradeError;
    const fn = upgrade ? 'qz_confirm_plan_upgrade' : 'qz_confirm_card_payment';
    const { error: confirmationError } = await admin.rpc(fn, {
      p_request_id: orderId,
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
      .eq('request_id', orderId).in('status', ['created', 'pending']);
    if (markError) throw markError;
    const { error: upgradeError } = await admin
      .from('qz_plan_upgrade_orders').update({ status: 'failed' })
      .eq('request_id', orderId).in('status', ['created', 'pending']);
    if (upgradeError) throw upgradeError;
    return 'failed';
  }
  return 'pending';
}
