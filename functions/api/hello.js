// Cloudflare Pages Functions 範例：GET /api/hello
export const onRequestGet = () => {
  return new Response(
    JSON.stringify({ ok: true, msg: "Hello from Cloudflare Functions!" }),
    { headers: { "content-type": "application/json" } }
  );
};
