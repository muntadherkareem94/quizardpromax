
import { createClient } from 'npm:@supabase/supabase-js@2';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const incoming = await req.json();
    const requestId = incoming?.requestId;
    const paymentId = incoming?.paymentId;

    if (!requestId || !paymentId) {
      return json({ error: 'Invalid notification' }, 400);
    }

    const url = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const terminal = Deno.env.get('QI_TERMINAL_ID');
    const username = Deno.env.get('QI_USERNAME');
    const password = Deno.env.get('QI_PASSWORD');

    if (
      !url || !serviceKey ||
      !terminal || !username || !password
    ) {
      return json({
        error: 'Gateway configuration missing'
      }, 503);
    }

    const admin = createClient(url, serviceKey);

    const invoice = await admin
      .from('qz_card_checkouts')
      .select('*')
      .eq('request_id', requestId)
      .maybeSingle();

    if (invoice.error) throw invoice.error;

    if (
      !invoice.data ||
      invoice.data.provider_payment_id !== paymentId
    ) {
      return json({ error: 'Unknown payment' }, 404);
    }

    if (invoice.data.status === 'paid') {
      return json({ ok: true, duplicate: true });
    }

    // The notification itself is NOT proof of payment.
    // Independently verify with Qi's authenticated API.
    const statusResponse = await fetch(
      'https://uat-sandbox-3ds-api.qi.iq/api/v1/payment/' +
      encodeURIComponent(paymentId) + '/status',
      {
        headers: {
          'X-Terminal-Id': terminal,
          'Authorization':
            'Basic ' + btoa(`${username}:${password}`),
          'Accept': 'application/json'
        }
      }
    );

    if (!statusResponse.ok) {
      return json({
        error: 'Gateway verification unavailable'
      }, 503);
    }

    const actual = await statusResponse.json();

    const amountMatches =
      Math.abs(
        Number(actual.amount) -
        Number(invoice.data.amount_iqd)
      ) < 0.001;

    if (
      actual.paymentId !== paymentId ||
      actual.requestId !== requestId ||
      actual.currency !== 'IQD' ||
      !amountMatches ||
      actual.canceled === true
    ) {
      return json({
        error: 'Provider payment does not match invoice'
      }, 400);
    }

    if (actual.status === 'SUCCESS') {
      const { error } = await admin.rpc(
        'qz_confirm_card_payment',
        {
          p_request_id: requestId,
          p_payment_id: paymentId,
          p_amount_iqd: Number(invoice.data.amount_iqd),
          p_currency: 'IQD'
        }
      );

      if (error) throw error;

      return json({ ok: true });
    }

    if (
      ['FAILED', 'AUTHENTICATION_FAILED']
        .includes(actual.status)
    ) {
      const update = await admin
        .from('qz_card_checkouts')
        .update({ status: 'failed' })
        .eq('request_id', requestId)
        .neq('status', 'paid');

      if (update.error) throw update.error;

      return json({
        ok: true,
        payment_status: 'failed'
      });
    }

    // Allow retry if payment is not yet final.
    return json({ payment_status: 'not_final' }, 503);

  } catch (error) {
    console.error('Payment verification failed:', error);

    return json({
      error: 'Payment verification failed'
    }, 503);
  }
});
