import { createClient } from 'npm:@supabase/supabase-js@2';
import { settleAlqasehPayment } from '../_shared/alqaseh.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const anon = Deno.env.get('SUPABASE_ANON_KEY');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !anon || !key) return json({ error: 'Not configured' }, 503);
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const client = createClient(url, anon);
    const { data: { user }, error } = await client.auth.getUser(token);
    if (error || !user) return json({ error: 'Sign in required' }, 401);
    const body = await req.json();
    const orderId = String(body?.request_id || '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId))
      return json({ error: 'Invalid request ID' }, 400);
    const admin = createClient(url, key);
    const { data: invoice, error: readError } = await admin
      .from('qz_card_checkouts').select('user_id')
      .eq('request_id', orderId).maybeSingle();
    if (readError) throw readError;
    if (!invoice || invoice.user_id !== user.id)
      return json({ error: 'Payment not found' }, 404);
    const status = await settleAlqasehPayment(admin, orderId);
    return json({ payment_status: status });
  } catch (error) {
    console.error('Al-Qaseh reconciliation:', error);
    return json({ error: 'Verification temporarily unavailable' }, 503);
  }
});
