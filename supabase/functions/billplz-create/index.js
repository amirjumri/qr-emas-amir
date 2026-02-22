// Minimal Billplz create-bill endpoint
// POST { txn_id, name, phone, email, amount, redirect_url, description }
import { serve } from "https://deno.land/std/http/server.ts";

const BILLPLZ_API = "https://www.billplz.com/api/v3/bills";
const KEY = Deno.env.get("5a65d066-c2e6-43b2-8761-742e119137d1");

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  try {
    const body = await req.json();
    const cents = Math.round(Number(body.amount) * 100); // Billplz amount in sen

    const payload = {
      collection_id: Deno.env.get("umhualc7"),
      email: body.email || "noreply@emasamir.app",
      name: body.name || "Pelanggan",
      amount: cents,
      callback_url: Deno.env.get("BILLPLZ_WEBHOOK_URL"), // will hit webhook function
      deliver: true,
      description: body.description || "Tabung emas",
      redirect_url: body.redirect_url,
      reference_1_label: "txn_id",
      reference_1: body.txn_id,
      reference_2_label: "phone",
      reference_2: body.phone || ""
    };

    const resp = await fetch(BILLPLZ_API, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + btoa(KEY + ":"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const j = await resp.json();
    if (!resp.ok) {
      return new Response(
        JSON.stringify({ message: j.error || "billplz error" }),
        { status: 400 }
      );
    }

    return new Response(
      JSON.stringify({ bill_url: j.url, bill_id: j.id }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ message: e.message || String(e) }),
      { status: 400 }
    );
  }
});