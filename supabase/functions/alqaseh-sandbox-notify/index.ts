// Independent Al-Qaseh sandbox callback sink.
// The transaction is NOT stored or used for Quizard entitlements.
// Client verifies the merchant API after redirect. Never trust this webhook
// or log its body as proof of payment.
Deno.serve((req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', {status:405});
  return new Response(JSON.stringify({ok: true}), {
    status: 200,
    headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}
  });
});
