function routeIntent({ msg, fileUrl, isLoggedIn, threadStatus }) {
  const t = String(msg || "").toLowerCase().trim();
  const hasFile = !!fileUrl;

  // ---------- BASIC ----------
  const isGreeting =
    t.includes("assalam") || t.includes("salam") || t.includes("slm") ||
    t.includes("hi") || t.includes("helo") || t.includes("hello") || t.includes("hai") ||
    t.includes("waalaikum") || t.includes("walaikum");

  const isDaily =
    (t.includes("harga") && t.includes("emas")) ||
    t.includes("berapa 916") || t.includes("berapa 999") ||
    (t.includes("harga") && (t.includes("916") || t.includes("999")));

  // lock keywords (ketatkan sikit)
  const isLock =
    t.includes("lock") || t.includes("lok") || t.includes("reserve") ||
    t.includes("booking") || t.includes("tempah") ||
    (t.includes("claim") && (t.includes("barang") || t.includes("item") || t.includes("live"))) ||
    (t.includes("live") && (t.includes("nak") || t.includes("saya") || t.includes("boleh") || t.includes("claim")));

  const isSemakTag =
    t === "semak tag" || t.includes("semak tag") || t.includes("check tag") || t.includes("baca tag");

  const moreItem =
    t.includes("ada lock lagi") || t.includes("lagi 1") || t.includes("lagi satu") || t.includes("satu lagi") ||
    t.includes("another") || t.includes("2 barang") || t.includes("dua barang") || t.includes("3 barang") || t.includes("tiga barang") ||
    t.includes("tambah lock") || t.includes("tambah lock lagi") || t.includes("nak tambah lock") ||
    t.includes("nak lock lagi") || t.includes("lock lagi") ||
    t.includes("tambah barang") || t.includes("tambah barang lagi") ||
    t.includes("tambah 1") || t.includes("tambah satu") || t.includes("tambah satu lagi") ||
    t.includes("add item") || t.includes("add another") || t.includes("add more");

  const forgotPrice =
    t === "lupa" || t === "lupa la" || t === "lupa lah" ||
    t.includes("lupa harga") || t.includes("tak ingat harga") || t.includes("x ingat harga") || t.includes("tidak ingat harga");

  const cut =
    t.includes("tak potong") || t.includes("x potong") || t.includes("potong") ||
    t.includes("pendek") || t.includes("shorten") || t.includes("cut");

  // ---------- SHIPPING ----------
  const pickup =
    t.includes("pickup") || t.includes("pick up") || t.includes("ambil") || t.includes("ambik") ||
    t.includes("kedai") || t.includes("walk in") || t.includes("walk-in") || t.includes("datang");

  const pos =
    t.includes("pos") || t.includes("post") || t.includes("courier") || t.includes("kurier") ||
    t.includes("hantar") || t.includes("delivery") || t.includes("ship");

  // ---------- PAYMENT ----------
  const payAtome =
    t.includes("atome") || t.includes("ansuran") || t.includes("installment") || t.includes("tomey");

  const payFPX =
    t === "fpx" || t.includes(" bayar fpx") || t.includes("fpx bank") || t.includes("online banking");

  // ketatkan transfer (buang "qr" general sebab boleh kacau QR Atome)
  const payTransfer =
    t.includes("transfer") || t.includes("bank transfer") || t.includes("online transfer") ||
    t.includes("duitnow") || t.includes("qr duitnow") || t.includes("qrpay") ||
    t.includes("tng") || t.includes("touch n go") || t.includes("boost");

  // tunai biar jadi kategori lain (kalau kau nak)
  const payCash =
    t.includes("tunai") || t.includes("cash");

  const cancelLock =
    t.includes("cancel") || t.includes("cansel") || t.includes("batalkan") || t.includes("batal") ||
    t.includes("tak jadi") || t.includes("x jadi") || t.includes("tak jadi beli") || t.includes("x jadi beli") ||
    t.includes("tak jadi ambik") || t.includes("x jadi ambik") ||
    (t.includes("maaf") && (t.includes("tak jadi") || t.includes("cancel") || t.includes("batal")));

  const stillInterestedYes =
    t === "ya" || t === "yes" || t === "ok" || t === "baik" ||
    t.includes("masih berminat") || t.includes("masih nak") || t.includes("nak teruskan") || t.includes("teruskan") ||
    t.includes("nak bayar") || t.includes("saya bayar") || t.includes("saya nak bayar") ||
    t.includes("proceed");

  const isShopHours =
    (t.includes("kedai") && (t.includes("buka") || t.includes("tutup"))) ||
    t.includes("buka pukul") || t.includes("buka kul") || t.includes("kedai buka") ||
    t.includes("hari ni buka") || t.includes("buka hari ni") ||
    t.includes("operasi") || t.includes("waktu operasi") || t.includes("waktu buka");

  const inLockFlow = String(threadStatus || "").toUpperCase().startsWith("LOCK_");

  const looksLikePaymentChoice = payAtome || payFPX || payTransfer || payCash;

  const looksLikeLockOps =
    isLock || isSemakTag || moreItem || forgotPrice || cut || pickup || pos || looksLikePaymentChoice || cancelLock;

  const isOtherQuestion =
    inLockFlow &&
    !hasFile &&
    !isGreeting &&
    !isDaily &&
    !looksLikeLockOps &&
    t.length > 0;

  const confidence = (x) => (x ? 0.9 : 0.6);

  return {
    isGreeting,
    isDaily,
    isLock,
    isSemakTag,
    moreItem,
    forgotPrice,
    cut,
    pickup,
    pos,
    payAtome,
    payFPX,
    payTransfer,
    payCash,
    cancelLock,
    stillInterestedYes,
    isShopHours,
    isOtherQuestion,
    inLockFlow,
    confidence: confidence(isLock || isDaily || isSemakTag || hasFile || cancelLock || isShopHours || looksLikePaymentChoice)
  };
}

module.exports = { routeIntent };