import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import UAParser from 'https://esm.sh/ua-parser-js@1.0.35'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    )

    const { data: { user } } = await supabaseClient.auth.getUser()
    if (!user) throw new Error('User not found')

    const ua = req.headers.get('User-Agent') || ''
    const parser = new UAParser(ua)
    const deviceInfo = `${parser.getBrowser().name} on ${parser.getOS().name}`

    // const ipAddress = req.headers.get('x-forwarded-for')?.split(',')[0]
    const ipAddress = req.headers.get('x-forwarded-for')?.split(',')[0]
    let location = 'Unknown'

    if (ipAddress) {
      try {
        console.log(`[DEBUG] Attempting to fetch location for IP: ${ipAddress}`);
        const geoRes = await fetch(`http://ip-api.com/json/${ipAddress}?fields=city,country`);
        console.log(`[DEBUG] Geo API response status: ${geoRes.status}`);

        if (geoRes.ok) {
          const geoData = await geoRes.json();
          console.log('[DEBUG] Geo API response data:', geoData);
          location = `${geoData.city}, ${geoData.country}`;
        } else {
          const errorText = await geoRes.text();
          console.error(`[DEBUG] Geo API request failed with status ${geoRes.status}: ${errorText}`);
          location = `API Error: ${geoRes.status}`;
        }
      } catch (e) {
        console.error('[DEBUG] Fetching location threw a network exception:', e);
        location = "Network Exception";
      }
    }

    // ... (The rest of the function remains the same) ...
    await supabaseClient.from('active_sessions').delete().eq('user_id', user.id).lt('expires_at', new Date().toISOString())
    const { count, error: countError } = await supabaseClient.from('active_sessions').select('*', { count: 'exact', head: true }).eq('user_id', user.id)
    if (countError) throw countError
    if (count != null && count >= 2) throw new Error("Device limit reached.")

    const expiryDate = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const { data: newSession, error: insertError } = await supabaseClient
      .from('active_sessions')
      .insert({
        user_id: user.id,
        expires_at: expiryDate.toISOString(),
        ip_address: ipAddress,
        location: location,
        device_info: deviceInfo
      })
      .select('session_id')
      .single()

    if (insertError) throw insertError

    return new Response(JSON.stringify(newSession), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error) {
    let errorMessage = "An unexpected error occurred.";
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})