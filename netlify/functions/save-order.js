// netlify/functions/save-order.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE; // guna service role di server-side SAHAJA

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false }
});

export default async (req, res) => {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const body = JSON.parse(req.body || '{}');
    // data dari frontend
    const {
      ref, sku, product_name, price, fee, total,
      phone, ic, alamat, potong, shipping
    } = body;

    // 1) upsert customer (guna function yang kita buat: upsert_customer)
    const { data: cidRows, error: cidErr } = await supabase
      .rpc('upsert_customer', {
        in_name: null,          // kalau nak simpan nama, hantar dari frontend
        in_phone: phone,
        in_ic: ic || null,
        in_alamat: alamat || null
      });

    if (cidErr) throw cidErr;
    const customer_id = Array.isArray(cidRows) ? cidRows[0] : cidRows; // bergantung versi supabase-js

    // 2) simpan order
    const { data: orderRow, error: ordErr } = await supabase
      .from('orders')
      .insert({
        ref,
        sku,
        product_name,
        price,
        fee,
        total,
        customer_id,
        shipping,
        alamat,
        potong
      })
      .select('id')
      .single();

    if (ordErr) throw ordErr;

    return res.status(200).json({ ok: true, order_id: orderRow.id, customer_id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
};