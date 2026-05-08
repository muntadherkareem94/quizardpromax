import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import UAParser from 'https://esm.sh/ua-parser-js@1.0.35'

const MAX_ACTIVE_DEVICES = 2
const SESSION_HOURS = 6

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: {
            Authorization: req.headers.get('Authorization')!,
          },
        },
      }
    )

    const {
      data: { user },
      error: userError,
    } = await supabaseClient.auth.getUser()

    if (userError || !user) {
      throw new Error('User not found')
    }

    let body: any = {}

    try {
      body = await req.json()
    } catch {
      body = {}
    }

    const deviceId =
      typeof body.device_id === 'string' && body.device_id.trim()
        ? body.device_id.trim()
        : null

    const existingSessionId =
      typeof body.existing_session_id === 'string' && body.existing_session_id.trim()
        ? body.existing_session_id.trim()
        : null

    const now = new Date()
    const nowIso = now.toISOString()
    const expiryDate = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000)
    const expiresAtIso = expiryDate.toISOString()

    const ua = req.headers.get('User-Agent') || ''
    const parser = new UAParser(ua)

    const browserName = parser.getBrowser().name || 'Unknown browser'
    const osName = parser.getOS().name || 'Unknown OS'
    const deviceInfo = `${browserName} on ${osName}`

    const ipAddress = req.headers.get('x-forwarded-for')?.split(',')[0] || null

    let location = 'Unknown'

    if (ipAddress) {
      try {
        const geoRes = await fetch(`http://ip-api.com/json/${ipAddress}?fields=city,country`)

        if (geoRes.ok) {
          const geoData = await geoRes.json()
          const city = geoData?.city || 'Unknown'
          const country = geoData?.country || 'Unknown'
          location = `${city}, ${country}`
        }
      } catch {
        location = 'Unknown'
      }
    }

    // 1. Remove expired sessions first.
    await supabaseClient
      .from('active_sessions')
      .delete()
      .eq('user_id', user.id)
      .lt('expires_at', nowIso)

    // 2. If this browser already has a stored session_id, refresh it instead of creating a new row.
    if (existingSessionId) {
      const { data: existingSession, error: existingSessionError } = await supabaseClient
        .from('active_sessions')
        .select('session_id')
        .eq('user_id', user.id)
        .eq('session_id', existingSessionId)
        .maybeSingle()

      if (existingSessionError) {
        throw existingSessionError
      }

      if (existingSession) {
        const { data: refreshedSession, error: refreshError } = await supabaseClient
          .from('active_sessions')
          .update({
            device_id: deviceId,
            expires_at: expiresAtIso,
            last_seen: nowIso,
            ip_address: ipAddress,
            location: location,
            device_info: deviceInfo,
          })
          .eq('user_id', user.id)
          .eq('session_id', existingSessionId)
          .select('session_id')
          .single()

        if (refreshError) {
          throw refreshError
        }

        return jsonResponse(refreshedSession)
      }
    }

    // 3. If this same browser/device already has a row, refresh that row instead of counting it as a new device.
    if (deviceId) {
      const { data: deviceSessions, error: deviceSessionsError } = await supabaseClient
        .from('active_sessions')
        .select('session_id, expires_at, created_at')
        .eq('user_id', user.id)
        .eq('device_id', deviceId)
        .order('expires_at', { ascending: false })

      if (deviceSessionsError) {
        throw deviceSessionsError
      }

      if (deviceSessions && deviceSessions.length > 0) {
        const sessionToKeep = deviceSessions[0]
        const duplicateSessionIds = deviceSessions.slice(1).map((s) => s.session_id)

        // Delete older duplicate rows from the same browser/device.
        if (duplicateSessionIds.length > 0) {
          await supabaseClient
            .from('active_sessions')
            .delete()
            .eq('user_id', user.id)
            .in('session_id', duplicateSessionIds)
        }

        const { data: refreshedDeviceSession, error: refreshDeviceError } = await supabaseClient
          .from('active_sessions')
          .update({
            expires_at: expiresAtIso,
            last_seen: nowIso,
            ip_address: ipAddress,
            location: location,
            device_info: deviceInfo,
          })
          .eq('user_id', user.id)
          .eq('session_id', sessionToKeep.session_id)
          .select('session_id')
          .single()

        if (refreshDeviceError) {
          throw refreshDeviceError
        }

        return jsonResponse(refreshedDeviceSession)
      }
    }

    // 4. Count active sessions only after expired rows and same-device duplicates are handled.
    const { count, error: countError } = await supabaseClient
      .from('active_sessions')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .gte('expires_at', nowIso)

    if (countError) {
      throw countError
    }

    if (count !== null && count >= MAX_ACTIVE_DEVICES) {
      return jsonResponse(
        {
          error: 'Device limit reached.',
          code: 'DEVICE_LIMIT_REACHED',
        },
        409
      )
    }

    // 5. Create a new active session only if this is truly a new device.
    const { data: newSession, error: insertError } = await supabaseClient
      .from('active_sessions')
      .insert({
        user_id: user.id,
        device_id: deviceId,
        expires_at: expiresAtIso,
        last_seen: nowIso,
        ip_address: ipAddress,
        location: location,
        device_info: deviceInfo,
      })
      .select('session_id')
      .single()

    if (insertError) {
      throw insertError
    }

    return jsonResponse(newSession)
  } catch (error) {
    let errorMessage = 'An unexpected error occurred.'

    if (error instanceof Error) {
      errorMessage = error.message
    }

    return jsonResponse({ error: errorMessage }, 400)
  }
})