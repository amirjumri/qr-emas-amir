function injectContent(tabId, url){
  if(!url) return;

  const ok =
    url.includes("tiktok.com") ||
    url.includes("localhost");

  if(!ok) return;

  chrome.scripting.executeScript({
    target:{ tabId },
    files:["content.js"]
  }, () => {
    chrome.runtime.lastError;
  });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if(changeInfo.status === "complete"){
    injectContent(tabId, tab.url || "");
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if(!msg || msg.type !== "EA_TIKTOK_COMMENT") return;

  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      const url = tab.url || "";

      if(url.includes("localhost")){
        chrome.tabs.sendMessage(tab.id, msg, () => {
          chrome.runtime.lastError;
        });
      }
    });
  });
});