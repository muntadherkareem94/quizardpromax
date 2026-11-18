// Safe, admin-only Al-Qaseh UAT smoke test: no Quizard purchases or entitlements.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { createAlqasehPayment } from '../_shared/alqaseh.ts';

const PREVIEW = 'https://deploy-preview-2--quizardpromax.netlify.app';
const CALLBACK = PREVIEW + '/alqaseh-sandbox-test.html';
const TEST_AMOUNT_IQD = 1000;
const VALID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cors = {
  'Access-Control-Allow-Origin': PREVIEW,
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {status,headers:cors});

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers:cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' },405);
  if (req.headers.get('origin') !== PREVIEW)
    return json({error: 'Only the Quizard sandbox preview may invoke this test'},403);
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !key || !anon) return json({ error: 'Supabase not configured' },503);
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i,'');
    if (!token) return json({error:'Sign in first'},401);
    const userClient = createClient(url,anon);
    const {data: {user},error} = await userClient.auth.getUser(token);
    if (error || !user) return json({error:'Invalid session'},401);
    const admin = createClient(url,key);
    const {data:profile,error:profileError} = await admin.from('users')
      .select('role').eq('id',user.id).maybeSingle();
    if (profileError) throw profileError;
    if (profile?.role !== 'admin') return json({error:'Admin-only sandbox test'},403);

    const input = await req.json().catch(()=>({}));
    if (input.action === 'start') {
      const orderId = crypto.randomUUID();
      const payment = await createAlqasehPayment({
        orderId,
        amountIQD: TEST_AMOUNT_IQD,
        description: 'Quizard independent UAT gateway test - no subscription or books',
        redirectUrl: CALLBACK
      });
      return json({checkout_url:payment.checkoutUrl,order_id:orderId,amount_iqd:TEST_AMOUNT_IQD});
    }
    if (input.action === 'status') {
      const orderId = String(input.order_id || '');
      const paymentId = String(input.payment_id || '');
      if (!VALID_ID.test(orderId) || !paymentId || paymentId.length > 250)
        return json({error:'Invalid payment reference'},400);
      const clientId = Deno.env.get('ALQASEH_CLIENT_ID');
      const secret = Deno.env.get('ALQASEH_CLIENT_SECRET');
      if (!clientId || !secret) return json({error:'Sandbox credentials unavailable'},503);
      const response = await fetch(
        'https://api-test.alqaseh.com/v1/egw/payments/history?' +
        new URLSearchParams({order_id:orderId,payment_id:paymentId,limit:'10'}),{
          headers:{Authorization:'Basic '+btoa(clientId+':'+secret),Accept:'application/json'}
        });
      if (!response.ok) return json({error:'Gateway verification unavailable'},502);
      const history = await response.json();
      const row = Array.isArray(history) ? history.find(
        (v: any)=>String(v.order_id)===orderId && String(v.payment_id)===paymentId
        && Number(v.amount)===TEST_AMOUNT_IQD && v.currency==='IQD'
      ):null;
      if (!row) return json({error:'Payment not found or verification mismatch'},404);
      return json({payment_status:String(row.payment_status),amount_iqd:TEST_AMOUNT_IQD,
        verified_by_gateway:true,quizard_access_changed:false});
    }
    return json({error:'Unknown action'},400);
  } catch (e) {
    console.error('Admin-only Al-Qaseh smoke test error:',e);
    return json({error:'Gateway test failed; see Supabase function logs'},502);
  }
});
