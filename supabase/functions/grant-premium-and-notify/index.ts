// This code goes into: supabase/functions/grant-premium-and-notify/index.ts

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from 'shared'

Deno.serve(async (req) => {
  // This is needed to handle OPTIONS requests from browsers
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { userId, expiresAt } = await req.json()
    if (!userId || !expiresAt) {
      throw new Error("User ID and expiration date are required.");
    }

    // Create a Supabase client with the SERVICE_ROLE_KEY to perform admin actions
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Step 1: Update the user to premium
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({ account_type: 'premium', premium_expires_at: expiresAt })
      .eq('id', userId);

    if (updateError) throw updateError;

    // Step 2: Create the notification content
    const expiryDateString = new Date(expiresAt).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric'
    });
    const notificationContent = `Congratulations! You are now a Premium member. Your subscription expires on ${expiryDateString}.`;

    // Step 3: Insert the main notification record
    const { data: newNotification, error: notificationError } = await supabaseAdmin
      .from('notifications')
      .insert({
          content: notificationContent,
          link_url: 'dashboard.html',
          type: 'premium_upgrade'
      })
      .select()
      .single();
    
    if (notificationError) throw notificationError;

    // Step 4: Link the notification to the user
    const { error: userNotificationError } = await supabaseAdmin
      .from('user_notifications')
      .insert({
          recipient_id: userId,
          notification_id: newNotification.id
      });

    if (userNotificationError) throw userNotificationError;

    return new Response(JSON.stringify({ message: "User promoted and notification sent successfully!" }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})