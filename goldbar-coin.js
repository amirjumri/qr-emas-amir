// ==========================
// Konfigurasi
// ==========================
const SB_URL = "https://dduizetstqqjrpsezbpi.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRkdWl6ZXRzdHFxanJwc2V6YnBpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg3MzI0ODQsImV4cCI6MjA3NDMwODQ4NH0.CrlHXrmHtKgR9qc2192U6quRb5lpFEeOSgwG0Lb8KRM";

window.sb = window.sb || window.supabase.createClient(SB_URL, SB_KEY);
const sb = window.sb;

const RPC_PRICE_LIST  = "goldbar_price_list_v1";     // kind, weight_g, upah_rm, price_per_g, harga_jual
const EDGE_BASE       = SB_URL + "/functions/v1";
const CREATE_BILL_URL = EDGE_BASE + "/create-bill-j999";   // Billplz (kekal)
const SP_SIGN_FN      = "sp-sign";                          // guna invoke (ELAK CORS)

// Redirect selepas berjaya bayar
const REDIRECT_URL    = location.origin + "/goldbar-coin.html?paid=1";

// ===== OnSend (WhatsApp) =====
const ADMIN_WA = "60168055916"; // nombor admin
const ONSEND_BASE  = "https://onsend.io/api/v1";
const ONSEND_TOKEN = "4b879470cc16ca8f06c5ab9878a4578880cfd0fd7b7cfe0121499f3ab017dd04";

// ✅ URL QR DuitNow (sama macam J916, boleh tukar bila perlu)
const QR_DUITNOW_URL = "https://emasamir.app/qr-maybank.html";

async function sendWA(msisdn, text){
  const phone_number = String(msisdn||"").replace(/\D/g,"").replace(/^0/,"60").replace(/^6(?=[1-9])/,"60");
  try{
    const r = await fetch(ONSEND_BASE + "/send",{
      method:"POST",
      headers:{
        "Accept":"application/json",
        "Content-Type":"application/json",
        "Authorization":"Bearer "+ONSEND_TOKEN
      },
      body: JSON.stringify({ phone_number, message:text, type:"text" })
    });
    const j = await r.json().catch(()=>({}));
    console.log("[OnSend]", r.status, j);
    return r.ok && j.success===true;
  }catch(e){ console.warn("OnSend error:", e); return false; }
}

// ==========================
// Tetapan Harga & Diskaun
// ==========================
const MARKUP_RATE = 0.08;

// Default (fallback); akan dioverride oleh DB payment_discounts
let PAYMENT_DISCOUNTS = {
  FPX:         { type:"PERCENT", value: 6 },
  CARD_EWALLET:{ type:"PERCENT", value: 5 },
  BNPL:        { type:"PERCENT", value: 0 }
};
const COUPON_LIST = {
  "RAYA10": { type: "PERCENT", value: 10, note: "Diskaun 10%" },
  "LESS5":  { type: "FIXED",   value: 5,  note: "Diskaun RM5" }
};

// ==========================
// Helper buat Order ID unik
// ==========================
function makeOrderId(prefix = 'GB') {
  const d = new Date();
  const ts =
    d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0') +
    String(d.getHours()).padStart(2, '0') +
    String(d.getMinutes()).padStart(2, '0') +
    String(d.getSeconds()).padStart(2, '0');
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${ts}-${rnd}`;
}

// ==========================
// Util & Elemen
// ==========================
const $ = id => document.getElementById(id);
const money = n => "RM " + Number(n || 0).toFixed(2);
const fmtG = g => {
  let s = Number(g).toString();
  if (s.includes(".")) s = s.replace(/0+$/,"").replace(/\.$/,"");
  return s + "g";
};
const dinarLabel = g =>
  ({ "1.0625":"1/4 dinar (1.0625g)", "2.125":"1/2 dinar (2.125g)", "4.25":"1 dinar (4.25g)" })[Number(g).toString()]
  || fmtG(g);

// ===== Agent helper (slug agen dari agent-ref.js / localStorage) =====
function getAgentRefCode(){
  try{
    const v = window.EmasAmirAgent?.getRef?.();
    if (v) return String(v).trim() || null;
  }catch(_){}

  try{
    if (typeof window.getAgentRef === "function"){
      const v2 = window.getAgentRef();
      if (v2) return String(v2).trim() || null;
    }
  }catch(_){}

  if (window.agent_ref) return String(window.agent_ref).trim() || null;
  if (window.AGENT_REF) return String(window.AGENT_REF).trim() || null;

  const v =
    localStorage.getItem("emasamir_agent_ref") ||
    localStorage.getItem("agent_ref") ||
    localStorage.getItem("agent_slug") ||
    "";

  return v ? String(v).trim() : null;
}

// ✅ BARU: paksa simpan agent ke localStorage (untuk pastikan “melekat”)
function persistAgentRef(agentSlug){
  try{
    const s = String(agentSlug || "").trim();
    if (!s) return;
    localStorage.setItem("emasamir_agent_ref", s);
  }catch(_){}
}

// ===== Snapshot helper (simpan sebelum redirect) =====
function saveCheckoutSnapshot({items, totals, refs, method}){
  const auth = getAuth() || {};
  const snap = {
    when: Date.now(),
    method,
    items,
    totals,
    refs,
    user: { name: auth.name || "", phone: auth.phone || "" },
    agent_ref: getAgentRefCode() || null
  };
  sessionStorage.setItem("gb_checkout_snapshot", JSON.stringify(snap));
  sessionStorage.removeItem("gb_wa_sent");
}

function getPaidAmount(order) {
  const cents = Number(order.amount_cents);
  if (Number.isFinite(cents) && cents > 0) {
    return cents / 100;
  }

  if (order.grand_total_rm != null) {
    const v = Number(order.grand_total_rm);
    if (Number.isFinite(v) && v > 0) return v;
  }

  if (order.total_rm != null) {
    const v = Number(order.total_rm);
    if (Number.isFinite(v) && v > 0) return v;
  }

  const v = Number(order.unit_price_rm || 0);
  return Number.isFinite(v) ? v : 0;
}

// ==========================
// 🔹 Auth helper
// ==========================
function getAuth(){
  const a = (window.auth_get && window.auth_get()) || null;
  if (a && (a.name || a.phone)) return a;
  const name  = localStorage.getItem('auth_name');
  const phone = localStorage.getItem('auth_phone');
  if (name || phone) return { name, phone };
  return null;
}
function requireLogin(){
  const auth = getAuth();
  if (!auth){
    alert("Sila log masuk dahulu untuk meneruskan checkout.");
    location.href = "login.html#login";
    return null;
  }
  return auth;
}

// ==========================
/* State global */
let BSModal = null, BSConfirm = null;
const state = {
  kind: 'coin',
  weight_g: 0.1,
  weight_label: '0.1g',
  upah: 0,
  hargaG: 0,
  cardType: 'READY',
  qty: 1,
  designList: [],
  selectedDesignId: null,
  selectedDesignName: '',
  selectedDesignCustomFee: 0,
  cart: [],
  checkoutMode: 'single',
  payMethod: 'FPX',
  coupon: null
};
const calcUnitPrice = (hargaG, g, upah, cardType, extra=0) => {
  const base = (Number(hargaG) * Number(g)) + Number(upah || 0)
             + ((cardType === 'CUSTOM') ? Number(extra || 0) : 0);
  return base * (1 + MARKUP_RATE);
};

// ==========================
// Modal Makluman Pembayaran (baru)
// ==========================
let BSPayInfo = null;
let payInfoOnGo = null;

function openPayInfo(method, onGo) {
  payInfoOnGo = typeof onGo === 'function' ? onGo : null;

  const m = String(method || '').toUpperCase();
  const isFPX = (m === 'FPX');

  const elMethod = $('payInfoMethod');
  if (elMethod) {
    elMethod.textContent = isFPX ? 'FPX' : 'Tunai / E-Wallet (Manual)';
  }

  const btnFPX  = $('btnPayInfoFPX');
  const btnCARD = $('btnPayInfoCARD');

  if (btnFPX)  btnFPX.style.display  = isFPX ? '' : 'none';
  if (btnCARD) btnCARD.style.display = isFPX ? 'none' : '';

  BSPayInfo = BSPayInfo || new bootstrap.Modal($('modalPayInfo'));
  BSPayInfo.show();
}

$('btnPayInfoFPX')?.addEventListener('click', async () => {
  if (typeof payInfoOnGo === 'function') {
    BSPayInfo?.hide();
    await payInfoOnGo();
  }
});
$('btnPayInfoCARD')?.addEventListener('click', async () => {
  if (typeof payInfoOnGo === 'function') {
    BSPayInfo?.hide();
    await payInfoOnGo();
  }
});

// ==========================
// Jadual harga (guna RPC)
// ==========================
async function renderTables(){
  const tbCoin  = $('tbCoin');
  const tbBar   = $('tbBar');
  const tbDinar = $('tbDinar');

  if (tbCoin)  tbCoin.innerHTML  = `<tr><td colspan="2">Memuatkan…</td></tr>`;
  if (tbBar)   tbBar.innerHTML   = `<tr><td colspan="2">Memuatkan…</td></tr>`;
  if (tbDinar) tbDinar.innerHTML = `<tr><td colspan="2">Memuatkan…</td></tr>`;

  const { data, error } = await sb.rpc(RPC_PRICE_LIST);
  if (error){
    const msg = `Ralat: ${error.message}`;
    if (tbCoin)  tbCoin.innerHTML  = `<tr><td colspan="2">${msg}</td></tr>`;
    if (tbBar)   tbBar.innerHTML   = `<tr><td colspan="2">${msg}</td></tr>`;
    if (tbDinar) tbDinar.innerHTML = `<tr><td colspan="2">${msg}</td></tr>`;
    console.warn("RPC_PRICE_LIST error:", error);
    return;
  }

  const rows   = Array.isArray(data) ? data : [];
  const coins  = rows.filter(r => String(r.kind || '').toLowerCase() === 'coin');
  const bars   = rows.filter(r => String(r.kind || '').toLowerCase() === 'bar');
  const dinars = rows.filter(r => String(r.kind || '').toLowerCase() === 'dinar');

  if (tbCoin){
    tbCoin.innerHTML = coins.length
      ? coins.map(r=>{
          const label = fmtG(r.weight_g);
          return `
            <tr class="rowitem clickable"
                data-kind="coin"
                data-weight="${Number(r.weight_g)}"
                data-label="${label}"
                data-upah="${Number(r.upah_rm)}"
                data-priceg="${Number(r.price_per_g)}"
                role="button" tabindex="0">
              <td><b>${label}</b></td>
              <td class="right"><b>${money(r.harga_jual)}</b></td>
            </tr>`;
        }).join("")
      : `<tr><td colspan="2">Tiada data.</td></tr>`;
  }

  if (tbBar){
    tbBar.innerHTML = bars.length
      ? bars.map(r=>{
          const label = fmtG(r.weight_g);
          return `
            <tr class="rowitem clickable"
                data-kind="bar"
                data-weight="${Number(r.weight_g)}"
                data-label="${label}"
                data-upah="${Number(r.upah_rm)}"
                data-priceg="${Number(r.price_per_g)}"
                role="button" tabindex="0">
              <td><b>${label}</b></td>
              <td class="right"><b>${money(r.harga_jual)}</b></td>
            </tr>`;
        }).join("")
      : `<tr><td colspan="2">Tiada data.</td></tr>`;
  }

  if (tbDinar){
    tbDinar.innerHTML = dinars.length
      ? dinars.map(r=>{
          const label = dinarLabel(r.weight_g);
          return `
            <tr class="rowitem clickable"
                data-kind="dinar"
                data-weight="${Number(r.weight_g)}"
                data-label="${label}"
                data-upah="${Number(r.upah_rm)}"
                data-priceg="${Number(r.price_per_g)}"
                role="button" tabindex="0">
              <td><b>${label}</b></td>
              <td class="right"><b>${money(r.harga_jual)}</b></td>
            </tr>`;
        }).join("")
      : `<tr><td colspan="2">Tiada data.</td></tr>`;
  }
}

// Delegation klik baris
function bindRowClicks(){
  ['tbCoin','tbBar','tbDinar'].forEach(id=>{
    const tbody = $(id);
    if (!tbody) return;

    tbody.addEventListener('click', (e)=>{
      const tr = e.target.closest('tr.rowitem');
      if(!tr) return;
      openDesignModal(
        tr.dataset.kind,
        parseFloat(tr.dataset.weight),
        tr.dataset.label,
        parseFloat(tr.dataset.upah),
        parseFloat(tr.dataset.priceg)
      );
    });

    tbody.addEventListener('keydown', (e)=>{
      if (e.key!=='Enter' && e.key!==' ') return;
      const tr = e.target.closest('tr.rowitem');
      if(!tr) return;
      e.preventDefault();
      openDesignModal(
        tr.dataset.kind,
        parseFloat(tr.dataset.weight),
        tr.dataset.label,
        parseFloat(tr.dataset.upah),
        parseFloat(tr.dataset.priceg)
      );
    });
  });
}

// ==========================
// Design listing
// ==========================
async function listDesigns(kind, weight_g){
  const { data, error } = await sb
    .from('goldbar_designs')
    .select('id,name,image_url,weight_g,kind,is_active,sort_order,extra_custom_fee_cents')
    .eq('kind',kind)
    .eq('weight_g',weight_g)
    .eq('is_active',true)
    .order('sort_order',{ascending:true});

  if (error){
    console.warn('goldbar_designs error:', error);
    return [];
  }
  return data || [];
}

function renderDesignGrid(){
  const grid = $('designGrid');
  const big  = $('bigPreview');
  const bigName = $('bigName');

  if (!state.designList.length){
    grid.innerHTML = `<div class="text-muted">Tiada design aktif untuk berat ini.</div>`;
    if (big){ big.src=""; big.alt=""; }
    if (bigName) bigName.textContent="";
    return;
  }

  grid.innerHTML = "";
  state.designList.forEach((d, idx)=>{
    const card = document.createElement('div');
    card.className = 'design-thumb';
    card.innerHTML = `
      <img class="thumb-img" src="${d.image_url}" alt="${d.name||''}">
      <div class="thumb-name">${d.name || 'Design'}</div>
    `;
    const selectThis = ()=>{
      state.selectedDesignId = d.id;
      state.selectedDesignName = d.name || '';
      state.selectedDesignCustomFee = Number(d.extra_custom_fee_cents || 0)/100 || 0;
      if (big){ big.src = d.image_url; big.alt = d.name || ''; }
      if (bigName) bigName.textContent = d.name || '';
      [...grid.querySelectorAll('.design-thumb')].forEach(el=>el.classList.remove('selected'));
      card.classList.add('selected');
      refreshPriceBox();
    };
    card.addEventListener('click', selectThis);
    if (idx===0) setTimeout(selectThis,0);
    grid.appendChild(card);
  });
}

function refreshPriceBox(){
  const unit = calcUnitPrice(state.hargaG, state.weight_g, state.upah, state.cardType, state.selectedDesignCustomFee);
  $('mdPriceUnit').textContent  = money(unit);
  $('mdPriceTotal').textContent = money(unit * state.qty);
}
function setCardType(type){
  state.cardType = (type==='CUSTOM') ? 'CUSTOM' : 'READY';
  $('optReady').checked  = state.cardType==='READY';
  $('optCustom').checked = state.cardType==='CUSTOM';
  refreshPriceBox();
}
function setQty(n){
  state.qty = Math.max(1, Math.min(99, Number(n||1)));
  $('qtyInput').value = String(state.qty);
  refreshPriceBox();
}

// ========= Paksa hidup & bind butang Checkout (fix UI)
function bindEnableCheckoutButtons(){
  const btnNow = $('btnBuyNow');
  const btnAll = $('btnCheckoutAll');

  [btnNow, btnAll].forEach(btn=>{
    if (!btn) return;
    btn.setAttribute('type','button');
    btn.disabled = false;
    btn.style.pointerEvents = 'auto';
    btn.style.opacity = 1;
  });

  if (btnNow && !btnNow.dataset.bound){
    btnNow.addEventListener('click', ()=>{
      if (!state.selectedDesignId){
        alert('Sila pilih satu design dahulu.');
        return;
      }
      state.checkoutMode = 'single';
      showConfirm(getItemsForCheckout());
    });
    btnNow.dataset.bound = '1';
  }
  if (btnAll && !btnAll.dataset.bound){
    btnAll.addEventListener('click', ()=>{
      state.checkoutMode = 'all';
      if (!state.cart.length){
        alert('Senarai kosong. Tambah item dahulu.');
        return;
      }
      showConfirm(getItemsForCheckout());
    });
    btnAll.dataset.bound = '1';
  }
}

// Buka modal pilih design
async function openDesignModal(kind, weight_g, weight_label, upah, hargaG){
  const modalEl = $('modalDesign');
  if (!modalEl) return;

  state.kind = String(kind || 'coin').trim().toLowerCase();
  state.weight_g = Number(weight_g);
  state.weight_label = weight_label;
  state.upah = Number(upah||0);
  state.hargaG = Number(hargaG||0);
  state.cardType = 'READY';
  state.qty = 1;
  state.selectedDesignId = null;
  state.selectedDesignName = '';
  state.selectedDesignCustomFee = 0;

  $('mdTitle').textContent = `Pilih Design • ${weight_label}`;
  $('mdNote').textContent  = `Design berikut adalah untuk ${weight_label}. Pilih Ready atau Custom, dan masukkan kuantiti.`;
  $('qtyInput').value = '1';
  $('optReady').checked = true;
  $('optCustom').checked = false;

  state.designList = await listDesigns(state.kind, weight_g);
  renderDesignGrid();
  refreshPriceBox();
  renderCart();

  bindEnableCheckoutButtons();

  BSModal = BSModal || new bootstrap.Modal(modalEl);
  BSModal.show();
}

// ==========================
// Mini Cart
// ==========================
function renderCart(){
  const body = $('cartBody');
  const sub = $('cartSubtotal');

  if (!state.cart.length){
    body.innerHTML = `<tr><td colspan="6" class="text-muted">Tiada item.</td></tr>`;
    sub.textContent = money(0);
    return;
  }

  body.innerHTML = "";
  let subtotal = 0;

  state.cart.forEach((it, idx)=>{
    const amount = it.unit * it.qty;
    subtotal += amount;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${it.weight_label} — ${it.design_name}</td>
      <td>${it.cardType==='CUSTOM'?'Custom':'Ready'}</td>
      <td class="text-end">${it.qty}</td>
      <td class="text-end">${money(it.unit)}</td>
      <td class="text-end">${money(amount)}</td>
      <td class="text-end">
        <button class="btn btn-sm btn-outline-danger" data-rm="${idx}">Buang</button>
      </td>
    `;
    tr.querySelector('[data-rm]').addEventListener('click', ()=>{
      state.cart.splice(idx,1);
      renderCart();
    });
    body.appendChild(tr);
  });

  sub.textContent = money(subtotal);
}

$('btnAddToList').addEventListener('click', ()=>{
  if (!state.selectedDesignId){
    alert('Sila pilih satu design dahulu.');
    return;
  }

  const unit = calcUnitPrice(state.hargaG, state.weight_g, state.upah, state.cardType, state.selectedDesignCustomFee);
  state.cart.push({
    kind: state.kind,
    weight_g: state.weight_g,
    weight_label: state.weight_label,
    cardType: state.cardType,
    qty: state.qty,
    unit,
    design_id: state.selectedDesignId,
    design_name: state.selectedDesignName,
    custom_fee: state.selectedDesignCustomFee || 0,
    price_per_g: state.hargaG,
    upah_rm: state.upah
  });
  renderCart();
});

// ==========================
// Confirm + kiraan
// ==========================
function getShippingCost(){
  const v = document.querySelector('input[name="shipOpt"]:checked')?.value || 'MY';
  if (v==='PU')  return 0;
  if (v==='MY')  return 10;
  if (v==='MYE') return 20;
  if (v==='SG')  return 45;
  return 10;
}
function getPaymentDiscountAmount(method, base){
  const rule = PAYMENT_DISCOUNTS[method] || {type:'PERCENT', value:0};
  if (rule.type === 'PERCENT') return base * (Number(rule.value)/100);
  if (rule.type === 'FIXED')   return Math.min(base, Number(rule.value));
  return 0;
}
function getCouponDiscountAmount(coupon, base){
  if (!coupon) return 0;
  if (coupon.type === 'PERCENT') return base * (Number(coupon.value)/100);
  if (coupon.type === 'FIXED')   return Math.min(base, Number(coupon.value));
  return 0;
}
function computeConfirmTotals(items){
  const subtotal = items.reduce((s,i)=> s + i.unit * i.qty, 0);
  const ship     = getShippingCost();
  const before   = subtotal + ship;
  const payDisc  = getPaymentDiscountAmount(state.payMethod, before);
  const afterPay = before - payDisc;
  const coupDisc = getCouponDiscountAmount(state.coupon, afterPay);
  const grand    = Math.max(0, afterPay - coupDisc);
  return { subtotal, ship, before, payDisc, coupDisc, grand };
}

function buildTotalsLinesGB(totals){
  const lines = [];

  lines.push(`Subtotal barang: ${money(totals.subtotal)}`);

  if (totals.ship > 0){
    lines.push(`Penghantaran: ${money(totals.ship)}`);
  }

  if (totals.payDisc > 0){
    let label = "Diskaun kaedah bayaran";
    if (state.payMethod === "FPX"){
      label = `Diskaun FPX (${PAYMENT_DISCOUNTS.FPX.value}%)`;
    } else if (state.payMethod === "CARD_EWALLET"){
      label = `Diskaun Tunai / E-Wallet (${PAYMENT_DISCOUNTS.CARD_EWALLET.value}%)`;
    } else if (state.payMethod === "BNPL"){
      label = "Diskaun BNPL";
    }
    lines.push(`${label}: - ${money(totals.payDisc)}`);
  }

  if (totals.coupDisc > 0){
    const code  = state.coupon?.code || "";
    const label = code ? `Diskaun kupon (${code})` : "Diskaun kupon";
    lines.push(`${label}: - ${money(totals.coupDisc)}`);
  }

  lines.push(`Grand Total perlu dibayar: ${money(totals.grand)}`);

  return lines;
}

function renderConfirmSummary(items){
  const t = computeConfirmTotals(items);
  $('cfSubtotal').textContent   = money(t.subtotal);
  $('cfShipping').textContent   = money(t.ship);
  $('cfPayDisc').textContent    = t.payDisc ? ('- ' + money(t.payDisc)) : '- RM 0.00';
  $('cfCouponDisc').textContent = t.coupDisc ? ('- ' + money(t.coupDisc)) : '- RM 0.00';
  $('cfGrand').textContent      = money(t.grand);
  return t;
}
function computeConfirmSummary(items){
  return computeConfirmTotals(items);
}
window.computeConfirmSummary = computeConfirmSummary;

function readPayMethod(){
  const r = document.querySelector('input[name="payMethod"]:checked');
  return r ? r.value : 'FPX';
}
function bindRadiosOnce(selector, handler){
  document.querySelectorAll(selector).forEach(el=>{
    const clone = el.cloneNode(true);
    el.parentNode.replaceChild(clone, el);
    clone.addEventListener('change', handler);
  });
}

// Baca diskaun kaedah bayaran dari DB dan override PAYMENT_DISCOUNTS
async function loadPaymentDiscountsFromDB(){
  try{
    const { data, error } = await sb
      .from("payment_discounts")
      .select("method, percent");

    if (error) {
      console.warn("[payDisc] load error:", error);
      return;
    }

    const map = new Map((data||[]).map(r => [String(r.method||"").toLowerCase(), Number(r.percent||0)]));

    const fpx  = map.get("fpx");
    const card = map.get("card_wallet");
    const bnpl = map.get("bnpl");

    if (Number.isFinite(fpx))  PAYMENT_DISCOUNTS.FPX.value          = fpx;
    if (Number.isFinite(card)) PAYMENT_DISCOUNTS.CARD_EWALLET.value = card;
    if (Number.isFinite(bnpl)) PAYMENT_DISCOUNTS.BNPL.value         = bnpl;

    const lblFPX  = document.querySelector('label[for="payFPX"]');
    const lblCARD = document.querySelector('label[for="payCARD"]');
    const lblBNPL = document.querySelector('label[for="payBNPL"]');
    if (lblFPX)  lblFPX.textContent  = `FPX (Diskaun ${PAYMENT_DISCOUNTS.FPX.value}%)`;
    if (lblCARD) lblCARD.textContent = `Tunai / E-Wallet (Manual) (Diskaun ${PAYMENT_DISCOUNTS.CARD_EWALLET.value}%)`;
    if (lblBNPL) lblBNPL.textContent = `PayLater / BNPL (Tiada diskaun)`;

    console.log("[payDisc] aktif:", PAYMENT_DISCOUNTS);
  }catch(e){
    console.warn("[payDisc] exception:", e);
  }
}

// ================== Tutup pilihan FPX — hanya Manual (CARD_EWALLET) sahaja ==================
function isFPXHiddenOrDisabled(){
  const el = document.getElementById('payFPX');
  if (!el) return true;

  if (el.disabled) return true;

  const wrapper = el.closest('.form-check') || el.parentElement;
  if (wrapper && wrapper.style.display === 'none') return true;

  return false;
}

function disableFPXForGoldbar(){
  const payFPX  = document.getElementById('payFPX');
  const btnFPX  = document.getElementById('btnProceedBillplz');
  const payCARD = document.getElementById('payCARD');

  if (payFPX){
    payFPX.checked  = false;
    payFPX.disabled = true;

    const wrapper = payFPX.closest('.form-check') || payFPX.parentElement;
    if (wrapper){
      wrapper.style.display = "none";
    }
  }

  if (payCARD){
    payCARD.checked = true;
  }
  state.payMethod = "CARD_EWALLET";

  if (btnFPX){
    btnFPX.style.display = "none";
  }

  console.log("[GB] FPX dimatikan di UI, kekal ada dalam kod.");
}

function showConfirm(items){
  const auth = requireLogin();
  if (!auth) return;

  const wrap = $('confirmItems');
  wrap.innerHTML = items.map((i)=>(
    `${i.weight_label} — ${i.design_name} (${i.cardType}) × ${i.qty} @ ${money(i.unit)}`
  )).join('<br>');
  const who = (auth.name || auth.phone || 'pengguna');
  wrap.insertAdjacentHTML('afterbegin', `<div class="text-muted mb-2">Log masuk sebagai <b>${who}</b></div>`);

  state.coupon = null;

  if (isFPXHiddenOrDisabled()){
    state.payMethod = 'CARD_EWALLET';
    $('payCARD')?.setAttribute('checked','');
    $('payFPX')?.removeAttribute('checked');
    $('payBNPL')?.removeAttribute('checked');
  } else {
    state.payMethod = 'FPX';
    $('payFPX')?.setAttribute('checked','');
    $('payCARD')?.removeAttribute('checked');
    $('payBNPL')?.removeAttribute('checked');
  }

  if ($('couponCode')) $('couponCode').value = '';
  if ($('couponStatus')) $('couponStatus').textContent = '';

  bindRadiosOnce('input[name="payMethod"]', ()=>{
    state.payMethod = readPayMethod();
    renderConfirmSummary(items);
  });
  bindRadiosOnce('input[name="shipOpt"]', ()=>{
    renderConfirmSummary(items);
  });
  $('btnApplyCoupon').onclick = ()=>{
    const code = ( $('couponCode').value || '' ).trim().toUpperCase();
    const info = COUPON_LIST[code] || null;
    state.coupon = info ? { code, type: info.type, value: info.value } : null;
    $('couponStatus').textContent = info ? `Kupon diterima: ${info.note || code}` : 'Kod tidak sah';
    renderConfirmSummary(items);
  };

  BSConfirm = BSConfirm || new bootstrap.Modal($('modalConfirm'));
  BSConfirm.show();

  ['btnProceedBillplz','btnProceedOther'].forEach(id=>{
    const b = $(id);
    if (b){
      b.disabled = false;
      b.style.pointerEvents = 'auto';
      b.style.opacity = 1;
    }
  });

  renderConfirmSummary(items);
}

// === Helpers telefon (BARU) ===
function to60(msisdn){
  const d = String(msisdn||'').replace(/\D/g,'');
  if(!d) return '';
  if (d.startsWith('60')) return d;
  if (d.startsWith('0'))  return '6'+d;
  return '60'+d;
}

// ==========================
// RPC: buat order
// ==========================
async function prepareOrderOnServer(item){
  const { data, error } = await sb.rpc('goldbar_order_prepare_v1', {
    p_kind:          String(item.kind || 'coin').toLowerCase(),
    p_weight_g:      Number(item.weight_g || 0),
    p_design_id:     item.design_id || null,
    p_design_name:   item.design_name || null,
    p_card_type:     String(item.cardType || 'READY').toUpperCase(),
    p_qty:           Number(item.qty || 1),
    p_price_per_g:   Number(item.price_per_g ?? 0),
    p_upah_rm:       Number(item.upah_rm ?? 0),
    p_custom_fee_rm: Number(item.custom_fee ?? 0)
  });

  if (error) throw error;

  if (typeof data === 'string') {
    console.log('[prepare_v1] Dapat direct string dari RPC:', data);
    return data;
  }

  const row = Array.isArray(data) ? data?.[0] : data;
  const ref =
    row?.reference_1 ||
    row?.reference ||
    row?.order_id ||
    row?.goldbar_order_id ||
    row?.id ||
    null;

  if (!ref) {
    console.warn('[prepare_v1] RPC data tanpa reference:', data);
    throw new Error('Rujukan pesanan tiada daripada prepare_v1.');
  }
  return ref;
}

async function attachBillId(ref, billId){
  if (!ref || !billId) return;

  const u1 = await sb
    .from('goldbar_order')
    .update({ bill_id_text: String(billId) })
    .eq('id', ref);

  if (u1.error) console.warn('[attachBillId:id] error:', u1.error);

  const u2 = await sb
    .from('goldbar_order')
    .update({ bill_id_text: String(billId) })
    .eq('reference_1', ref);

  if (u2.error) console.warn('[attachBillId:reference_1] error:', u2.error);
}

// ====== ISI customer_phone & customer_name UNTUK ID-ID ORDER YANG DIBUAT (VERSI BARU) ======
async function attachCustomerToOrders(orderRefs, phoneFromSession = null, nameFromSession = null){
  if (!orderRefs?.length) return;

  const a = getAuth() || {};
  const rawPhone =
    (phoneFromSession ?? '') ||
    a.phone ||
    localStorage.getItem('auth_phone') ||
    '';

  const phone60 =
    rawPhone ? to60(rawPhone) : null;

  const custName =
    nameFromSession ||
    a.name ||
    localStorage.getItem('auth_name') ||
    null;

  if (!phone60 && !custName){
    console.warn('[attachCustomerToOrders] Tiada phone & nama dlm sesi. refs =', orderRefs);
    return;
  }

  const payload = {
    customer_phone: phone60 || null,
    customer_name:  custName || null
  };

  const up1 = await sb
    .from('goldbar_order')
    .update(payload)
    .in('id', orderRefs);

  if (up1.error) console.warn('[attachCustomerToOrders:id] error:', up1.error);

  const up2 = await sb
    .from('goldbar_order')
    .update(payload)
    .in('reference_1', orderRefs);

  if (up2.error) console.warn('[attachCustomerToOrders:reference_1] error:', up2.error);

  console.log('[attachCustomerToOrders] siap. refs=', orderRefs,
              'upd1=', up1?.data?.length || 0,
              'upd2=', up2?.data?.length || 0,
              'payload=', payload);
}

// ====== ISI agent_slug UNTUK ORDER YANG DIBUAT (BARU) ======
async function attachAgentToOrders(orderRefs){
  if (!orderRefs?.length) return;

  const agentSlug = getAgentRefCode();
  if (!agentSlug){
    console.log("[attachAgentToOrders] tiada agentSlug dalam localStorage / URL");
    return;
  }

  persistAgentRef(agentSlug);

  const payload = { agent_slug: agentSlug };

  const up1 = await sb
    .from('goldbar_order')
    .update(payload)
    .in('id', orderRefs);

  if (up1.error) console.warn('[attachAgentToOrders:id] error:', up1.error);

  const up2 = await sb
    .from('goldbar_order')
    .update(payload)
    .in('reference_1', orderRefs);

  if (up2.error) console.warn('[attachAgentToOrders:reference_1] error:', up2.error);

  console.log('[attachAgentToOrders] siap. agent=', agentSlug, 'refs=', orderRefs);
}

async function attachBillIdIfExists(orderId, billId){
  try{
    const { error } = await sb
      .from('goldbar_order')
      .update({ bill_id: billId })
      .eq('id', orderId);
    if (error && error.code !== '42703') console.warn('attachBillIdIfExists warn:', error);
  }catch(e){ console.warn('attachBillIdIfExists exception:', e); }
}

// ====== BUAT SEMUA ORDER DARI CART, SIMPAN SENARAI REF (ID + reference_1) ======
async function createRefsForItems(items){
  const ids = [];
  for (const it of items){
    const rawId = await prepareOrderOnServer(it);
    ids.push(String(rawId));
  }

  let refs = [...ids];
  try {
    const { data, error } = await sb
      .from('goldbar_order')
      .select('id, reference_1')
      .in('id', ids);

    if (error){
      console.warn('[createRefsForItems] select reference_1 error:', error);
    } else if (Array.isArray(data) && data.length){
      refs = data.map(r => r.reference_1 || r.id);
    }
  } catch (e){
    console.warn('[createRefsForItems] exception select reference_1:', e);
  }

  const keys = Array.from(new Set([...(ids||[]), ...(refs||[])])).filter(Boolean);

  const a = getAuth() || {};
  const rawPhone = a.phone || localStorage.getItem('auth_phone') || "";
  const phone = rawPhone ? to60(rawPhone) : null;
  const name  = a.name || localStorage.getItem('auth_name') || null;

  try{
    if (phone || name){
      const { data, error } = await sb.rpc('goldbar_orders_attach_customer_fix_v1', {
        p_keys_csv: keys.join(','),
        p_phone: phone,
        p_name: name
      });
      console.log('[GB attach customer FIX]', data, error);
    }
  }catch(e){
    console.warn('[GB attach customer FIX] exception:', e);
  }

  try{
    const agentSlug = getAgentRefCode();
    if (agentSlug){
      persistAgentRef(agentSlug);
      const { data, error } = await sb.rpc('goldbar_orders_attach_agent_fix_v1', {
        p_keys_csv: keys.join(','),
        p_agent_slug: agentSlug
      });
      console.log('[GB attach agent FIX]', data, error);
    }else{
      console.log('[GB attach agent FIX] agentSlug kosong');
    }
  }catch(e){
    console.warn('[GB attach agent FIX] exception:', e);
  }

  if (refs.length > 1) {
    try {
      const { data, error } = await sb.rpc('goldbar_orders_attach_group_v1', {
        p_references_csv: refs.join(","),
        p_group: null
      });
      console.log("[checkout_group J999]", data, error);
    } catch (e) {
      console.warn("[checkout_group J999 EXCEPTION]", e);
    }
  }

  console.log('[createRefsForItems] siap.', { ids, refs, keys, phone, name });
  return refs;
}

// ==========================
// Senarai item untuk checkout (single / all)
// ==========================
function getItemsForCheckout(){
  if (state.checkoutMode === 'single'){
    return [{
      kind:         state.kind,
      weight_g:     state.weight_g,
      weight_label: state.weight_label,
      cardType:     state.cardType,
      qty:          state.qty,
      unit:         calcUnitPrice(
                      state.hargaG,
                      state.weight_g,
                      state.upah,
                      state.cardType,
                      state.selectedDesignCustomFee
                    ),
      design_id:    state.selectedDesignId,
      design_name:  state.selectedDesignName,
      custom_fee:   state.selectedDesignCustomFee || 0,
      price_per_g:  state.hargaG,
      upah_rm:      state.upah
    }];
  }

  return state.cart.slice();
}

// ====== (KEKAL) SIMPAN META CHECKOUT (shipping, method, diskaun, kupon, grand) ======
async function attachCheckoutMeta(refs, totals){
  try{
    const { error } = await sb.rpc('goldbar_orders_attach_meta_v1', {
      p_references_csv: refs.join(','),
      p_ship_rm:  Number(totals.ship || 0),
      p_pay_method: String(state.payMethod || 'FPX'),
      p_payment_disc_rm: Number(totals.payDisc || 0),
      p_coupon_code: state.coupon?.code || null,
      p_coupon_disc_rm: Number(totals.coupDisc || 0),
      p_grand_rm: Number(totals.grand || 0)
    });
    if (error) console.warn('attachCheckoutMeta RPC warn:', error);
  }catch(e){
    console.warn('attachCheckoutMeta exception (ignored):', e);
  }
}

// ==========================
// FPX (Billplz) — fungsi utama (boleh dipanggil dari mana-mana)
// ==========================
async function payWithBillplz() {
  if (!requireLogin()) return;
  if (state.payMethod !== 'FPX'){
    alert('Sila pilih kaedah FPX untuk butang ini.');
    return;
  }

  const btn = $('btnProceedBillplz');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Menyedia bil…";
  }

  try{
    const items    = getItemsForCheckout();
    const totals   = computeConfirmTotals(items);
    const amountRm = Number(totals.grand).toFixed(2);

    const refs = await createRefsForItems(items);
    await attachCheckoutMeta(refs, totals);

    saveCheckoutSnapshot({ items, totals, refs, method: 'FPX' });
    sessionStorage.setItem('gb_expect', '1');

    const res = await fetch(CREATE_BILL_URL, {
      method: "POST",
      headers: { "Content-Type":"application/json", "Authorization":"Bearer "+SB_KEY },
      body: JSON.stringify({
        txn_id: refs.join(","),
        amount: Number(amountRm),
        description: `Gold checkout (${items.length} item) + shipping`,
        redirect_url: REDIRECT_URL,
        name:  (getAuth()?.name  || getAuth()?.phone || "Pelanggan"),
        email: "",
        phone: (getAuth()?.phone || "")
      })
    });

    const j = await res.json().catch(()=>({}));
    if (!res.ok || !j?.ok || !j?.bill_url){
      console.error('create-bill response:', j);
      throw new Error(j?.error || j?.message || "Billplz ralat.");
    }

    for (const r of refs){
      await attachBillId(r, j.bill_id || "");
    }

    BSConfirm?.hide();
    BSModal?.hide?.();
    location.href = j.bill_url;
  }catch(err){
    console.error('Billplz error:', err);
    alert("Ralat Billplz: " + (err?.message || err));
  }finally{
    if (btn){
      btn.disabled = false;
      btn.textContent = "Bayar FPX";
    }
  }
}

// ==========================
// BAYAR FPX (Billplz) — klik butang -> buka modal makluman dulu
// ==========================
$('btnProceedBillplz')?.addEventListener('click', ()=>{
  if (!requireLogin()) return;
  if (state.payMethod !== 'FPX'){
    alert('Sila pilih kaedah FPX untuk butang ini.');
    return;
  }
  openPayInfo('FPX', payWithBillplz);
});

// ==========================
// Tunai / E-Wallet (Manual) — guna WhatsApp + OnSend
// ==========================
async function proceedManualPay(){
  const user = requireLogin();
  if (!user) return;

  if (state.payMethod === "FPX"){
    alert('Sila pilih "Tunai / E-Wallet (Manual)" dahulu.');
    return;
  }

  const goBtn = document.getElementById('btnProceedOther');
  if (goBtn){
    goBtn.disabled = true;
    goBtn.textContent = "Menyedia pesanan…";
  }

  try{
    const items  = getItemsForCheckout();
    const totals = computeConfirmTotals(items);
    const refs   = await createRefsForItems(items);

    await attachCheckoutMeta(refs, totals);

    saveCheckoutSnapshot({ items, totals, refs, method: 'MANUAL' });

    const phone60 = to60(user.phone || '');
    const name    = user.name || phone60 || "Pelanggan";
    const agentRef = getAgentRefCode();

    const shipVal   = document.querySelector('input[name="shipOpt"]:checked')?.value || 'PU';
    const shipLabel = ({
      PU:  "Pick Up di Kedai",
      MY:  "Semenanjung Malaysia",
      MYE: "Sabah/Sarawak",
      SG:  "Singapore"
    })[shipVal] || shipVal;

    const itemLines = items.map(i =>
      `• ${i.weight_label} — ${i.design_name} (${i.cardType}) × ${i.qty} @ ${money(i.unit)}`
    );

    const totalLines = buildTotalsLinesGB(totals);

    const msgAdmin = [
      "*LOCK MANUAL GOLD BAR/COIN*",
      "",
      `Nama: ${name}`,
      `No: ${phone60 || "-"}`,
      "",
      "Kaedah: Tunai / E-Wallet (Manual)",
      `Penghantaran: ${shipLabel}`,
      agentRef ? `Kod Agen: ${agentRef}` : null,
      `Rujukan: ${refs.join(",")}`,
      "",
      "Item:",
      ...itemLines,
      "",
      "Ringkasan jumlah:",
      ...totalLines,
      "",
      "Status: Menunggu bayaran manual & resit daripada pelanggan."
    ].join("\n");

    const msgCust = [
      `Terima kasih ${name}! Ini ringkasan pesanan GoldBar/Coin anda di Emas Amir.`,
      "",
      "Kaedah bayaran: Tunai / E-Wallet (Manual)",
      `Penghantaran: ${shipLabel}`,
      agentRef ? `Kod Agen: ${agentRef}` : null,
      "",
      "Item:",
      ...itemLines,
      "",
      "Ringkasan jumlah:",
      ...totalLines,
      "",
      "No Akaun untuk Pembayaran Secara Online Transfer",
      "👇🏻👇🏻👇🏻",
      "Bank   : Maybank",
      "Nama   : EMAS AMIR SDN. BHD.",
      "No Akaun : 552031155695",
      "Reference : LETAK NO 4 DIGIT AKHIR WHATSAPP ANDA",
      "",
      QR_DUITNOW_URL ? `Atau boleh juga scan QR berikut: ${QR_DUITNOW_URL}` : "",
      "",
      "Sila buat bayaran Tunai / E-Wallet / Online Transfer mengikut jumlah di atas.",
      "Selepas berjaya, sila hantarkan resit bayaran kepada admin Emas Amir di WhatsApp. ✅"
    ].filter(Boolean).join("\n");

    await sendWA(ADMIN_WA, msgAdmin);
    if (phone60) await sendWA(phone60, msgCust);

    const mEl = $('modalAfterManualGB');
    if (mEl){
      try {
        BSConfirm?.hide();
        BSPayInfo?.hide?.();
      } catch(e){
        console.warn("Hide modal lama gagal:", e);
      }

      const m = new bootstrap.Modal(mEl);
      m.show();

      $('btnManualHomeGB')?.addEventListener('click', ()=> {
        location.href = "index.html";
      });

      setTimeout(()=> {
        location.href = "index.html";
      }, 8000);
    } else {
      location.href = "index.html";
    }

  }catch(e){
    console.error("Manual pay error:", e);
    alert("Ralat semasa sediakan pesanan manual. Sila cuba lagi.");
  }finally{
    if (goBtn){
      goBtn.disabled = false;
      goBtn.textContent = "Tunai / E-Wallet (Manual)";
    }
  }
}

// Butang “Tunai / E-Wallet (Manual)”
$('btnProceedOther')?.addEventListener('click', ()=>{
  if (!requireLogin()) return;
  if (state.payMethod === 'FPX'){
    alert('Sila pilih "Tunai / E-Wallet (Manual)" dahulu.');
    return;
  }
  openPayInfo('CARD', proceedManualPay);
});

// Pastikan bila modal confirm dipaparkan, butang confirm sentiasa hidup
document.addEventListener('shown.bs.modal', (e)=>{
  if (e.target?.id === 'modalDesign') bindEnableCheckoutButtons();
  if (e.target?.id === 'modalConfirm'){
    ['btnProceedBillplz','btnProceedOther'].forEach(id=>{
      const b = $(id);
      if (b){
        b.disabled=false;
        b.style.pointerEvents='auto';
        b.style.opacity=1;
      }
    });
  }
});

// ===== Selepas balik dari gateway -> hantar WA =====
async function afterPaidFlow(){
  if (sessionStorage.getItem("gb_wa_sent") === "1") return;

  const raw = sessionStorage.getItem("gb_checkout_snapshot");
  if (!raw) return;

  const snap = JSON.parse(raw);
  const { user, items, totals, method } = snap;

  const lines = items.map(i => `• ${i.weight_label} — ${i.design_name} (${i.cardType}) × ${i.qty} @ ${money(i.unit)}`);

  const msgAdmin = [
    "✅ *Pembelian GoldBar/Coin (PAID)*",
    `Nama: ${user.name || "-"}`,
    `No: ${user.phone || "-"}`,
    `Kaedah: ${method}`,
    "",
    ...lines,
    "",
    `Jumlah: ${money(totals.grand)}`,
    `Penghantaran: ${money(totals.ship)}`,
    `Tarikh: ${new Date().toLocaleString("ms-MY",{dateStyle:"medium", timeStyle:"short"})}`
  ].join("\n");

  const msgCust = [
    "Terima kasih! Pesanan GoldBar/Coin anda telah *berjaya dibayar (PAID)*.",
    ...lines,
    "",
    `Jumlah dibayar: ${money(totals.grand)}`,
    "Kami akan proses & hubungi anda untuk penghantaran. 🙏"
  ].join("\n");

  const okA = await sendWA(ADMIN_WA, msgAdmin);
  const okC = await sendWA(user.phone || "", msgCust);
  console.log("[GB afterPaid]", {okA, okC});

  sessionStorage.setItem("gb_wa_sent", "1");
}

async function verifyPaid(billId){
  try{
    const { data, error } = await sb
      .from('billplz_callback')
      .select('paid_bool')
      .ilike('bill_id_text', billId)
      .order('created_at', { ascending:false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn('verifyPaid error:', error);
      return false;
    }
    return data?.paid_bool === true;
  }catch(e){
    console.warn('verifyPaid exception:', e);
    return false;
  }
}

// ==========================
// Controls asas + Init
// ==========================
$('optReady')?.addEventListener('change', ()=> setCardType('READY'));
$('optCustom')?.addEventListener('change', ()=> setCardType('CUSTOM'));
$('qtyMinus')?.addEventListener('click', ()=> setQty(state.qty-1));
$('qtyPlus')?.addEventListener('click', ()=> setQty(state.qty+1));
$('qtyInput')?.addEventListener('input', e=> setQty(e.target.value));

(async function initGoldbarCoin(){
  bindRowClicks();
  await renderTables();
  await loadPaymentDiscountsFromDB();

  console.log("[GB] agentRef=", getAgentRefCode(), "ls=", localStorage.getItem("emasamir_agent_ref"));

  disableFPXForGoldbar();

  try{
    const auth = getAuth();
    const status = $("loginStatus");
    if (auth){
      status.textContent = "Log masuk sebagai " + (auth.name || auth.phone || "pengguna");
      $("btnLogin").style.display = "none";
      $("btnLogout").style.display = "";
      $("btnLogout").onclick = ()=>{
        window.auth_clear && window.auth_clear();
        localStorage.removeItem('auth_name');
        localStorage.removeItem('auth_phone');
        location.reload();
      };
    } else {
      status.textContent = "Tidak log masuk";
      $("btnLogin").style.display = "";
      $("btnLogout").style.display = "none";
      $("btnLogin").onclick = ()=> location.href="login.html#login";
    }
  }catch(e){
    console.warn("Auth status error:", e);
  }
})();

// --- Detect balik dari gateway (Billplz/SenangPay) ---
(function detectPaid(){
  const qs = new URLSearchParams(location.search);

  const billId        = (qs.get('billplz[id]') || '').toLowerCase();
  const billplzPaid   = qs.get('billplz[paid]') === 'true';
  const billplzPaidAt = !!qs.get('billplz[paid_at]');

  const spOK = (qs.get('status_id') === '1');

  const simplePaid = ['1','true','yes'].includes((qs.get('paid')||'').toLowerCase());

  const isPaidNow = (billplzPaid && billplzPaidAt) || spOK || simplePaid;
  if (!isPaidNow) return;

  setTimeout(async ()=>{
    try {
      if (billId) {
        const ok = await verifyPaid(billId);
        if (!ok) return;
      }
      await afterPaidFlow();
    } finally {
      sessionStorage.removeItem('gb_expect');
      const url = new URL(location.href);
      [
        'paid','billplz[id]','billplz[paid]','billplz[paid_at]','billplz[signature]',
        'status_id','order_id','transaction_id','msg'
      ].forEach(k => url.searchParams.delete(k));
      history.replaceState(null, '', url.toString());
    }
  }, 1200);
})();



/* =========================
   iPhone-style swipe back (Gold Bar) with drag animation
   - swipe dari tepi kiri
   - page ikut jari
   - modal tutup dulu
   - kalau tak cukup jauh, snap balik
   ========================= */
(function(){
  const page = document.querySelector('.page-shell');
  if (!page) return;

  let startX = 0;
  let startY = 0;
  let currentX = 0;
  let tracking = false;
  let dragging = false;

  const EDGE_ZONE = 24;
  const MAX_DY = 70;
  const TRIGGER_RATIO = 0.33;

  function getOpenModalEl(){
    const modals = Array.from(document.querySelectorAll('.modal.show'));
    return modals.length ? modals[modals.length - 1] : null;
  }

  function closeTopModal(){
    const el = getOpenModalEl();
    if (!el) return false;

    try{
      const modalInst = bootstrap.Modal.getInstance(el) || bootstrap.Modal.getOrCreateInstance(el);
      modalInst.hide();
      return true;
    }catch(_){
      el.classList.remove('show');
      el.style.display = 'none';
      document.body.classList.remove('modal-open');
      document.querySelectorAll('.modal-backdrop').forEach(x => x.remove());
      return true;
    }
  }

  function goBackPage(){
    if (window.history.length > 1){
      history.back();
    }else{
      location.href = 'index.html';
    }
  }

  function resetPage(){
    page.classList.remove('dragging');
    page.style.transform = 'translateX(0)';
    setTimeout(()=>{
      document.body.classList.remove('swipe-peek');
    }, 220);
  }

  document.addEventListener('touchstart', function(e){
    if (!e.touches || !e.touches.length) return;

    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    currentX = 0;
    dragging = false;

    tracking = startX <= EDGE_ZONE;
  }, { passive:true });

  document.addEventListener('touchmove', function(e){
    if (!tracking || !e.touches || !e.touches.length) return;

    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = Math.abs(t.clientY - startY);

    if (dy > MAX_DY) return;
    if (dx <= 0) return;

    currentX = dx;
    dragging = true;

    document.body.classList.add('swipe-peek');
    page.classList.add('dragging');
    page.style.transform = `translateX(${dx}px)`;
  }, { passive:true });

  document.addEventListener('touchend', function(){
    if (!tracking) return;

    tracking = false;
    page.classList.remove('dragging');

    if (!dragging){
      document.body.classList.remove('swipe-peek');
      return;
    }

    const threshold = window.innerWidth * TRIGGER_RATIO;

    if (currentX >= threshold){
      page.style.transform = `translateX(${window.innerWidth}px)`;

      setTimeout(()=>{
        if (closeTopModal()) {
          page.style.transition = 'none';
          page.style.transform = 'translateX(0)';
          void page.offsetHeight;
          page.style.transition = '';
          document.body.classList.remove('swipe-peek');
          return;
        }

        goBackPage();
      }, 180);
    } else {
      resetPage();
    }

    dragging = false;
    currentX = 0;
  }, { passive:true });
})();
