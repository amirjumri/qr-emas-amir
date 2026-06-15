(function(){

const seen = new Set();

function clean(s){
  return String(s || "")
    .replace(/\s+/g," ")
    .trim();
}

function bad(t){
  t = clean(t).toLowerCase();

  return (
    !t ||
    t.includes("joined") ||
    t.includes("welcome to tiktok") ||
    t.includes("community guidelines") ||
    t.includes("get coins") ||
    t.includes("recharge") ||
    t.includes("recommended live") ||
    t === "live" ||
    t === "new"
  );
}

function key(name,msg){
  return (name+"|"+msg)
    .toLowerCase()
    .replace(/[^a-z0-9]/g,"");
}

function pushComment(name,msg){

  if(bad(name) || bad(msg)) return;

  const k = key(name,msg);
  if(seen.has(k)) return;
  seen.add(k);

  console.log("LIVE COMMENT:", {
    name,
    comment:msg
  });

  const feed = document.getElementById("ea-live-feed");

  if(feed){
    const div = document.createElement("div");

    div.style.cssText = `
      padding:10px;
      border-bottom:1px solid rgba(255,255,255,.1);
      font-size:14px;
    `;

    div.innerHTML = `
      <b style="color:#facc15">@${name}</b><br>
      <span>${msg}</span>
    `;

    feed.prepend(div);
  }
}

function scan(){

  const raw = [...document.querySelectorAll("div")]
    .map(x => x.innerText || "")
    .filter(x =>
      x.includes("Viewers") &&
      x.includes("Welcome to TikTok LIVE")
    )
    .sort((a,b)=>a.length-b.length)[0];

  if(!raw) return;

  const lines = raw
    .split("\n")
    .map(clean)
    .filter(Boolean);

  for(let i=0;i<lines.length-1;i++){

    const name = lines[i];
    const msg  = lines[i+1];

    if(
      !bad(name) &&
      !bad(msg) &&
      msg.length > 2 &&
      msg.length < 120
    ){
      pushComment(name,msg);
    }
  }
}

function createPanel(){

  if(document.getElementById("ea-live-panel")) return;

  const panel = document.createElement("div");

  panel.id = "ea-live-panel";

  panel.innerHTML = `
    <div style="
      position:fixed;
      right:10px;
      top:10px;
      width:360px;
      height:80vh;
      background:#0b0b0b;
      border:2px solid #facc15;
      border-radius:18px;
      z-index:999999;
      overflow:hidden;
      box-shadow:0 0 30px rgba(0,0,0,.5);
    ">
      <div style="
        padding:14px;
        background:#111;
        color:#facc15;
        font-weight:900;
        border-bottom:1px solid rgba(255,255,255,.1);
      ">
        AI Live Comment • Emas Amir
      </div>

      <div id="ea-live-feed" style="
        height:calc(100% - 52px);
        overflow:auto;
        color:#fff;
      "></div>
    </div>
  `;

  document.body.appendChild(panel);
}

createPanel();

setInterval(scan,1000);

console.log("EA LIVE READY");

})();