
import { createClient } from 'npm:@supabase/supabase-js@2';
import { createAlqasehPayment } from '../_shared/alqaseh.ts';

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

  const returnUrl = Deno.env.get('QUIZARD_RETURN_URL');

  if (
    !url || !anonKey || !serviceKey ||
    !returnUrl
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


const targetPlan = String(body?.target_plan_slug || '').trim().toLowerCase();

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

    const { paymentId, checkoutUrl } = await createAlqasehPayment({
      orderId: requestId,
      amountIQD: Number(quote.net_iqd),
      description: 'Quizard plan change to ' + targetPlan + ' (' + months + ' months)',
      redirectUrl: callback.href,
      webhookUrl: url + '/functions/v1/alqaseh-payment-webhook'
    });
    providerPaymentCreated = true;

    const savedPayment = await admin
      .from('qz_card_checkouts')
      .update({
        provider_payment_id: paymentId,
        provider: 'alqaseh',
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
  checkout_url: checkoutUrl,
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
