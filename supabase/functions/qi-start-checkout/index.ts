
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

const respond = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: cors
  });

Deno.serve(async (req) => {
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
    return respond({
      error: 'Sandbox payment gateway is not configured.'
    }, 503);
  }

  try {
    const token = (
      req.headers.get('authorization') || ''
    ).replace(/^Bearer\s+/i, '');

    if (!token) {
      return respond({ error: 'Sign in required.' }, 401);
    }

    const publicClient = createClient(url, anonKey);

    const {
      data: { user },
      error: authError
    } = await publicClient.auth.getUser(token);

    if (authError || !user) {
      return respond({ error: 'Unauthorized.' }, 401);
    }

    const body = await req.json();
    const slug = body.plan_slug;
    const months = Number(body.months);

    if (
      !['premium', 'platinum'].includes(slug) ||
      ![3, 6, 12].includes(months)
    ) {
      return respond({
        error: 'Invalid subscription selection.'
      }, 400);
    }

    const admin = createClient(url, serviceKey);

    const profile = await admin
      .from('users')
      .select('speciality')
      .eq('id', user.id)
      .single();

    if (profile.error) throw profile.error;

    const speciality = String(
      profile.data?.speciality || ''
    ).trim();


if (!speciality) {
      return respond({
        error: 'Choose your account specialty first.'
      }, 400);
    }

    // Do not create overlapping full-price memberships.
    // Active Premium users must use the pro-rated upgrade
    // flow. Active Platinum users cannot downgrade.
    const nowIso = new Date().toISOString();

    const existing = await admin
      .from('qz_user_plan_subscriptions')
      .select('plan_slug')
      .eq('user_id', user.id)
      .eq('speciality', speciality)
      .lte('starts_at', nowIso)
      .gt('expires_at', nowIso)
      .limit(1);

    if (existing.error) throw existing.error;

    if (existing.data?.length) {
      return respond({
        error:
          'You already have an active subscription. ' +
          'Open Personal Profile to manage your plan.'
      }, 409);
    }

    // Never trust a price supplied by the browser.

    const [plan, rate, memberships] = await Promise.all([
      admin.from('qz_specialty_plans')
        .select('enabled')
        .eq('speciality', speciality)
        .eq('plan_slug', slug)
        .single(),

      admin.from('qz_specialty_plan_prices')
        .select('amount_iqd,enabled')
        .eq('speciality', speciality)
        .eq('plan_slug', slug)
        .eq('months', months)
        .single(),

      admin.from('qz_specialty_plan_books')
        .select('book_id,tier')
        .eq('speciality', speciality)
    ]);

    for (const result of [plan, rate, memberships]) {
      if (result.error) throw result.error;
    }

    const amount = Number(rate.data?.amount_iqd);

    const hasBooks = (memberships.data || []).some(m =>
      m.tier === 'premium' ||
      (slug === 'platinum' && m.tier === 'platinum')
    );

    if (
      !plan.data?.enabled ||
      !rate.data?.enabled ||
      !hasBooks ||
      !Number.isSafeInteger(amount) ||
      amount <= 0
    ) {
      return respond({
        error: 'This plan is not available for purchase.'
      }, 400);
    }

  
const requestId = crypto.randomUUID();

const callback = new URL(returnUrl);

if (callback.protocol !== 'https:') {
  return respond({
    error: 'Secure return URL required.'
  }, 500);
}

// Include our own payment reference in the return URL.
// Never use this URL parameter as proof of successful payment.
callback.searchParams.set('requestId', requestId);


    // Record the intended transaction before contacting Qi.
    const insert = await admin.from('qz_card_checkouts')
      .insert({
        request_id: requestId,
        user_id: user.id,
        speciality,
        plan_slug: slug,
        months,
        amount_iqd: amount,
        status: 'created'
      });

    if (insert.error) throw insert.error;

    // Sandbox only. Do not replace with production credentials
    // until the entire payment lifecycle is approved and tested.
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
          amount,
          currency: 'IQD',
          locale: 'en_US',
          appChannel: false,
          finishPaymentUrl: callback.href,
          notificationUrl:
            `${url}/functions/v1/qi-payment-webhook`,
          additionalInfo: {
            source: 'quizard',
            subscription: slug
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
      throw Error(
        'Payment provider could not create checkout.'
      );
    }

    // Refuse to send users to an untrusted payment website.
    const checkout = new URL(payment.formUrl);

    if (
      checkout.protocol !== 'https:' ||
      !(
        checkout.hostname === 'qi.iq' ||
        checkout.hostname.endsWith('.qi.iq')
      )
    ) {
      throw Error('Untrusted payment gateway URL.');
    }

    const update = await admin
      .from('qz_card_checkouts')
      .update({
        provider_payment_id: payment.paymentId,
        status: 'pending'
      })
      .eq('request_id', requestId);

    if (update.error) throw update.error;

    return respond({
      checkout_url: checkout.href,
      request_id: requestId
    });

  } catch (error) {
    console.error('Checkout initiation error:', error);

    return respond({
      error: 'Unable to start secure checkout.'
    }, 502);
  }
});
