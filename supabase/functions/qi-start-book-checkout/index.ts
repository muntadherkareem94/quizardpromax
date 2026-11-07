
import { createClient } from 'npm:@supabase/supabase-js@2';

// Qi SANDBOX: individual-book checkout.
// Does not create or modify a subscription plan.

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

  try {
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
        error: 'Sandbox checkout is not configured.'
      }, 503);
    }

    const token = (
      req.headers.get('authorization') || ''
    ).replace(/^Bearer\s+/i, '');

    if (!token) {
      return respond({ error: 'Sign in required' }, 401);
    }

    const publicClient = createClient(url, anonKey);

    const {
      data: { user },
      error: authError
    } = await publicClient.auth.getUser(token);

    if (authError || !user) {
      return respond({ error: 'Unauthorized' }, 401);
    }

    const body = await req.json();


const bookId = String(body?.book_id || '').trim();
const months = Number(body?.months);

if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(bookId)) {
  return respond({ error: 'Invalid book ID' }, 400);
}

if (![3, 6, 12].includes(months)) {
  return respond({
    error: 'Choose 3, 6, or 12 months of book access.'
  }, 400);
}


    const admin = createClient(url, serviceKey);

    // Read actual book, sale rule and user's specialty
    // on the server. Do not trust browser prices.
    const [book, rule, profile, existingLicense] =
      await Promise.all([
        admin.from('books')
          .select('id,title')
          .eq('id', bookId)
          .maybeSingle(),

        admin.from('qz_book_rules')
         

.select(
  'access_mode,standalone_enabled,' +
  'standalone_price_iqd,standalone_price_6m_iqd,' +
  'standalone_price_9m_iqd'
)


          .eq('book_id', bookId)
          .maybeSingle(),

        admin.from('users')
          .select('speciality')
          .eq('id', user.id)
          .single(),

        admin.from('qz_user_book_licenses')
          .select('expires_at')
          .eq('user_id', user.id)
          .eq('book_id', bookId)
          .maybeSingle()
      ]);

    for (const result of [
      book, rule, profile, existingLicense
    ]) {
      if (result.error) throw result.error;
    }

    if (!book.data) {
      return respond({ error: 'Book not found' }, 404);
    }

    const speciality = String(
      profile.data?.speciality || ''
    ).trim();

    if (!speciality) {
      return respond({
        error: 'Account specialty is required.'
      }, 400);
    }

 

// The customer selects a duration, NOT a price.
// Read the matching price directly from Supabase.

const priceField =
  months === 3
    ? 'standalone_price_iqd'
    : months === 6
      ? 'standalone_price_6m_iqd'
      : 'standalone_price_12m_iqd';

const amount = Number(rule.data?.[priceField]);

const saleEnabled =
  rule.data?.standalone_enabled === true &&
  rule.data?.access_mode !== 'free' &&
  rule.data?.[priceField] != null &&
  Number.isSafeInteger(amount) &&
  amount > 0;

if (!saleEnabled) {
  return respond({
    error: 'This book duration is not available for purchase.'
  }, 400);
}



// Sale eligibility and selected-duration price
// have already been validated above.


    // Prevent charging again for a book already
    // owned through a standalone book license.
    const license = existingLicense.data;

    if (
      license &&
      (
        license.expires_at === null ||
        new Date(license.expires_at).getTime() > Date.now()
      )
    ) {
      return respond({
        error: 'You already own this book.'
      }, 409);
    }

    // Create a new, unique transaction.
    const requestId = crypto.randomUUID();

    const callback = new URL(returnUrl);

    if (callback.protocol !== 'https:') {
      return respond({
        error: 'HTTPS return URL required.'
      }, 500);
    }

    callback.searchParams.set('requestId', requestId);

    const insert = await admin
      .from('qz_card_checkouts')
      .insert({
        request_id: requestId,
        user_id: user.id,
        kind: 'book',
       
book_id: bookId,
speciality,
plan_slug: null,
months: null,

book_duration_months: months,
amount_iqd: amount,

currency: 'IQD',
status: 'created'

      });

    if (insert.error) throw insert.error;

    // Create sandbox checkout on Qi's hosted page.
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
            productType: 'book',
            bookId
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
      throw Error('Qi did not create a book checkout.');
    }

    const checkout = new URL(payment.formUrl);

    if (
      checkout.protocol !== 'https:' ||
      !(
        checkout.hostname === 'qi.iq' ||
        checkout.hostname.endsWith('.qi.iq')
      )
    ) {
      throw Error('Untrusted gateway destination.');
    }

    // Link our transaction to the Qi payment.
    const update = await admin
      .from('qz_card_checkouts')
      .update({
        provider_payment_id: payment.paymentId,
        status: 'pending'
      })
      .eq('request_id', requestId)
      .eq('status', 'created');

    if (update.error) throw update.error;

    return respond({
      checkout_url: checkout.href,
      request_id: requestId
    });

  } catch (error) {
    console.error('Individual book checkout:', error);

    return respond({
      error: 'Unable to start book checkout.'
    }, 502);
  }
});
