
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: cors
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: cors });
  }

  if (req.method !== 'POST') {
    return respond({ error: 'Method not allowed' }, 405);
  }

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  const terminal = Deno.env.get('QI_TERMINAL_ID');
  const username = Deno.env.get('QI_USERNAME');
  const password = Deno.env.get('QI_PASSWORD');
  const returnUrl = Deno.env.get('QUIZARD_RETURN_URL');

  if (
    !url || !anonKey || !serviceKey ||
    !terminal || !username || !password || !returnUrl
  ) {
    return respond({ error: 'Gateway configuration missing' }, 503);
  }

  let requestId: string | null = null;
  let providerPaymentCreated = false;

  const admin = createClient(url, serviceKey);

  try {
    const token = (
      req.headers.get('authorization') || ''
    ).replace(/^Bearer\s+/i, '');

    if (!token) {
      return respond({ error: 'Sign in required' }, 401);
    }

    // Validate the actual Supabase session.
    const publicClient = createClient(url, anonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    });

    const { data: auth, error: authError } =
      await publicClient.auth.getUser(token);

    if (authError || !auth?.user) {
      return respond({ error: 'Unauthorized' }, 401);
    }

    const body = await req.json();


const targetPlan = String(
  body?.target_plan_slug || ''
).trim().toLowerCase();

const months = Number(body?.months);
const maxAmount = Number(body?.max_amount_iqd);

if (
  !['premium', 'platinum'].includes(targetPlan) ||
  ![3, 6, 12].includes(months) ||
  !Number.isSafeInteger(maxAmount) ||
  maxAmount <= 0
) {
  return respond({ error: 'Invalid upgrade selection' }, 400);
}


    // Creates a checkout and a frozen upgrade quote
    // atomically, based on the authenticated user.

const { data: quote, error: quoteError } =
  await publicClient.rpc('qz_plan_change_quote', {
    p_target_plan_slug: targetPlan,
    p_months: months,
    p_create: true,
    p_max_amount_iqd: maxAmount
  });


    if (quoteError) {
      return respond({ error: quoteError.message }, 409);
    }

    requestId = String(quote?.request_id || '');

    if (!requestId || !quote?.net_iqd) {
      throw Error('Upgrade quote was not created');
    }

    const callback = new URL(returnUrl);

    if (callback.protocol !== 'https:') {
      throw Error('Secure return URL required');
    }

    callback.searchParams.set('requestId', requestId);

    // Use the same hosted Qi Sandbox checkout
    // as normal subscriptions.
    const response = await fetch(
      'https://uat-sandbox-3ds-api.qi.iq/api/v1/payment',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Terminal-Id': terminal,
          'Authorization':
            'Basic ' + btoa(`${username}:${password}`)
        },
        body: JSON.stringify({
          requestId,
          amount: quote.net_iqd,
          currency: 'IQD',
          locale: 'en_US',
          appChannel: false,
          finishPaymentUrl: callback.href,
          notificationUrl:
            `${url}/functions/v1/qi-payment-webhook`,

additionalInfo: {
  source: 'quizard',
  productType: 'plan_upgrade',
  targetPlan,
  months
}

        })
      }
    );

    const payment = await response.json()
      .catch(() => ({}));

    if (
      !response.ok ||
      !payment.paymentId ||
      !payment.formUrl
    ) {
      throw Error('Qi could not create upgrade payment');
    }

    providerPaymentCreated = true;

    const checkout = new URL(payment.formUrl);
    const host = checkout.hostname.toLowerCase();

    if (
      checkout.protocol !== 'https:' ||
      !(host === 'qi.iq' || host.endsWith('.qi.iq'))
    ) {
      throw Error('Untrusted payment destination');
    }

    const savedPayment = await admin
      .from('qz_card_checkouts')
      .update({
        provider_payment_id: payment.paymentId,
        status: 'pending'
      })
      .eq('request_id', requestId)
      .eq('status', 'created')
      .select('request_id')
      .single();

    if (savedPayment.error) throw savedPayment.error;

    const savedUpgrade = await admin
      .from('qz_plan_upgrade_orders')
      .update({ status: 'pending' })
      .eq('request_id', requestId)
      .eq('status', 'created')
      .select('request_id')
      .single();

    if (savedUpgrade.error) throw savedUpgrade.error;


return respond({
  checkout_url: checkout.href,
  request_id: requestId,
  current_plan: quote.current_plan,
  current_months: quote.current_months,
  target_plan: quote.target_plan,
  target_months: quote.target_months,
  gross_iqd: quote.gross_iqd,
  credit_iqd: quote.credit_iqd,
  net_iqd: quote.net_iqd
});


  } catch (error) {
    console.error('Upgrade checkout error:', error);

    // Only mark a checkout failed when Qi has not
    // reported creating a payment.
    // Otherwise preserve records for reconciliation.
    if (requestId && !providerPaymentCreated) {
      await admin.from('qz_card_checkouts')
        .update({ status: 'failed' })
        .eq('request_id', requestId)
        .eq('status', 'created');

      await admin.from('qz_plan_upgrade_orders')
        .update({ status: 'failed' })
        .eq('request_id', requestId)
        .eq('status', 'created');
    }

    return respond({
      error: 'Unable to start upgrade checkout'
    }, 502);
  }
});
