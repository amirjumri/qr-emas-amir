console.log("DEEPLINK JS LOADED");

(function () {
  function handleDeepLink(rawUrl, source) {
    console.log("DEEPLINK RAW:", source, rawUrl);
    if (!rawUrl) return;

    try {
      const url = new URL(rawUrl);
      if (url.hostname !== "emasamir.app") return;

      const path = url.pathname + url.search + url.hash;
      console.log("DEEPLINK PATH:", path);

      if (path && path !== "/") {
        window.location.replace(path);
      }
    } catch (e) {
      console.log("DEEPLINK ERROR:", e);
    }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    console.log("DEEPLINK DOM READY");

    if (!window.Capacitor) {
      console.log("NO CAPACITOR");
      return;
    }

    const App = window.Capacitor.Plugins?.App;

    if (!App) {
      console.log("APP PLUGIN TAK JUMPA");
      return;
    }

    try {
      const launch = await App.getLaunchUrl();
      console.log("DEEPLINK LAUNCH:", launch);
      if (launch && launch.url) {
        handleDeepLink(launch.url, "launch");
      }
    } catch (e) {
      console.log("GET LAUNCH URL ERROR:", e);
    }

    App.addListener("appUrlOpen", function (event) {
      console.log("DEEPLINK APP URL OPEN:", event);
      handleDeepLink(event?.url, "appUrlOpen");
    });
  });
})();