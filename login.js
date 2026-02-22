/* global auth_set */
(function() {
  "use strict";

  // ====== CONFIG ======
  var ADMIN_PHONE = "60168055916";
  var SB_URL = "https://dduizetstqqjrpsezbpi.supabase.co";
  var SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRkdWl6ZXRzdHFxanJwc2V6YnBpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg3MzI0ODQsImV4cCI6MjA3NDMwODQ4NH0.CrlHXrmHtKgR9qc2192U6quRb5lpFEeOSgwG0Lb8KRM";
  var supabase = (SB_URL && SB_KEY && window.supabase)

  // ====== UTIL ======
  function $(id){ return document.getElementById(id); }
  function onlyDigits(s){ return (s||"").replace(/\D+/g,""); }
  function genOTP(){ return String(Math.floor(100000 + Math.random()*900000)); }

  // ====== Tabs (upgrade JS, fallback CSS kekal)
  function setTabFromHash(){
    var h = location.hash || "#login";
    if(h === "#signup"){
      $("tabSignup").classList.add("active");
      $("tabLogin").classList.remove("active");
      $("signupView").style.display = "block";
      $("loginView").style.display  = "none";
    }else{
      $("tabLogin").classList.add("active");
      $("tabSignup").classList.remove("active");
      $("loginView").style.display  = "block";
      $("signupView").style.display = "none";
    }
  }
  window.addEventListener("hashchange", setTabFromHash);
  setTabFromHash();

  // ====== Auto-isi 4 digit terakhir & hint
  function wireLast4(phoneId,last4Id,statusId){
    var pEl=$(phoneId), l4El=$(last4Id), stEl=$(statusId);
    function sync(){
      var p = onlyDigits(pEl.value);
      if(p.length>=4) l4El.value = p.slice(-4);
      if(stEl){
        var ok = p.length>=4 && onlyDigits(l4El.value) === p.slice(-4);
        stEl.textContent = ok ? "" : "4 digit terakhir tak padan.";
      }
    }
    pEl.addEventListener("input", sync);
    l4El.addEventListener("input", sync);
  }
  wireLast4("su_phone","su_last4","su_status");
  wireLast4("li_phone","li_last4","li_status");

  // ====== LOGIN ======
  $("btnLogin").addEventListener("click", function(){
    try{
      var phone = onlyDigits($("li_phone").value);
      var last4 = onlyDigits($("li_last4").value);
      var pass  = $("li_pass").value;

      if(!/^\d{9,12}$/.test(phone)) { $("li_status").textContent="Nombor telefon tak sah."; return; }
      if(!/^\d{4}$/.test(last4))     { $("li_status").textContent="Isi 4 digit terakhir."; return; }
      if(pass.length<6)              { $("li_status").textContent="Password minima 6 aksara."; return; }
      if(phone.slice(-4)!==last4)    { $("li_status").textContent="4 digit terakhir tak padan."; return; }
      if(!supabase){ $("li_status").textContent="Supabase belum dikonfigurasi."; return; }

      supabase.rpc("login_password", { in_phone: phone, in_password: pass })
      .then(function(res){
        var data = res.data, error = res.error;
        if(error || !data || data.length===0){
          console.error(error);
          $("li_status").textContent = "Log masuk gagal. Semak nombor / password.";
          return;
        }
        var u = Array.isArray(data) ? data[0] : data;
        auth_set({ id:u.id, name:u.name, phone:u.phone, ic:u.ic, alamat:u.alamat });
        location.href = "order.html";
      })
      .catch(function(e){
        console.error(e); $("li_status").textContent="Ralat tak dijangka semasa log masuk.";
      });
    }catch(e){ console.error(e); $("li_status").textContent="Ralat tak dijangka semasa log masuk."; }
  });

  // ====== SIGNUP + OTP ======
  var _otp = null, _otp_ts = 0;

  $("su_btnOtp").addEventListener("click", function(){
    var phone = onlyDigits($("su_phone").value);
    var last4 = onlyDigits($("su_last4").value);

    if(!/^\d{9,12}$/.test(phone)) { $("su_status").textContent="Nombor telefon tak sah."; return; }
    if(!/^\d{4}$/.test(last4))    { $("su_status").textContent="Isi 4 digit terakhir."; return; }
    if(phone.slice(-4)!==last4)   { $("su_status").textContent="4 digit terakhir tak padan."; return; }

    _otp = genOTP(); _otp_ts = Date.now();

    var msg =
      "OTP Daftar Akaun Emas Amir\n" +
      "Telefon: " + phone + "\n" +
      "OTP: " + _otp + "\n\n" +
      "(Hantar mesej ini untuk sahkan pendaftaran)";

    window.open("https://wa.me/" + ADMIN_PHONE + "?text=" + encodeURIComponent(msg), "_blank");
    $("su_status").textContent = "OTP dijana & WhatsApp dibuka — tekan Send.";
  });

  $("su_btnCreate").addEventListener("click", function(){
    try{
      var phone = onlyDigits($("su_phone").value);
      var last4 = onlyDigits($("su_last4").value);
      var name  = $("su_name").value.trim();
      var ic    = onlyDigits($("su_ic").value);
      var alamat= $("su_alamat").value.trim();
      var pass1 = $("su_pass").value;
      var pass2 = $("su_pass2").value;
      var code  = onlyDigits($("su_otp").value);

      if(!/^\d{9,12}$/.test(phone)) { $("su_status").textContent="Nombor telefon tak sah."; return; }
      if(phone.slice(-4)!==last4)   { $("su_status").textContent="4 digit terakhir tak padan."; return; }
      if(!/^\d{6}$/.test(code))     { $("su_status").textContent="Isi OTP 6 digit."; return; }
      if(!_otp || Date.now()-_otp_ts>5*60*1000){ $("su_status").textContent="OTP tamat tempoh. Mohon dapatkan semula."; return; }
      if(code!==_otp)               { $("su_status").textContent="OTP salah."; return; }
      if(pass1.length<6 || pass1!==pass2){ $("su_status").textContent="Password tak sah / tidak sepadan."; return; }
      if(ic && ic.length!==12)      { $("su_status").textContent="IC perlu 12 digit (atau kosongkan)."; return; }
      if(!supabase){ $("su_status").textContent="Supabase belum dikonfigurasi."; return; }

      supabase.rpc("register_finish", {
        in_name: name || phone,
        in_phone: phone,
        in_ic: ic || "",
        in_alamat: alamat || "",
        in_password: pass1
      })
      .then(function(res){
        var data = res.data, error = res.error;
        if(error){ console.error(error); $("su_status").textContent="Daftar gagal: " + error.message; return; }
        auth_set({ id: data, name: name||phone, phone: phone, ic: ic, alamat: alamat });
        location.href = "order.html";
      })
      .catch(function(e){
        console.error(e); $("su_status").textContent="Ralat tak dijangka semasa daftar.";
      });
    }catch(e){ console.error(e); $("su_status").textContent="Ralat tak dijangka semasa daftar."; }
  });

})();