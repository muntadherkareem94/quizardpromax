import { createClient } from 'npm:@supabase/supabase-js@2';
import { settleAlqasehPayment } from '../_shared/alqaseh.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
  });

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = await req.json();
    const orderId = String(body?.order_id || '');
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return json({ error: 'Not configured' }, 503);
    const admin = createClient(url, key);
    // Treat webhook contents as untrusted. Recheck status/amount/order
    // using Al-Qaseh's authenticated API before granting access.
    const status = await settleAlqasehPayment(admin, orderId);
    return json({ ok: true, payment_status: status });
  } catch (error) {
    console.error('Al-Qaseh webhook verification:', error);
    return json({ error: 'Unable to verify payment' }, 503);
  }
});
