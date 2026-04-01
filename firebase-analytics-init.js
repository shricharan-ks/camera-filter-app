/**
 * Firebase Analytics (compat). Client API keys are public.
 *
 * Skips initialization on localhost / LAN / file — avoids ERR_CONNECTION_REFUSED when
 * blockers, Pi-hole, or offline dev block region1.google-analytics.com.
 *
 * Force on in dev: sessionStorage.setItem("campaign_analytics_dev","1") then reload.
 * Force off: window.__FORCE_CAMPAIGN_ANALYTICS__ = false (set before this script).
 *
 * @see https://firebase.google.com/docs/analytics/get-started?platform=web
 *
 * Custom events and parameters are documented in `app.js` (logCampaignEvent block near the top).
 * In GA4, register dimensions for string params you slice by (e.g. photo_source, video_source, layout).
 */
(function initCampaignFirebaseAnalytics() {
  /** @type {Record<string, unknown>} */
  const firebaseConfig = {
    apiKey: "AIzaSyD1qkBfmzzrtEAf3WR6PpWLcI_yovvyno4",
    authDomain: "dmk-kumarapalayam.firebaseapp.com",
    projectId: "dmk-kumarapalayam",
    storageBucket: "dmk-kumarapalayam.firebasestorage.app",
    messagingSenderId: "971188085340",
    appId: "1:971188085340:web:52ae3316cfea1f22c6fc99",
    measurementId: "G-PQBCG3KCEX",
  };

  /**
   * @param {string} name
   * @param {Record<string, string | number>} [params]
   */
  function campaignLogEvent(name, params) {
    try {
      var a = window.__campaignFirebaseAnalytics;
      if (a && typeof a.logEvent === "function") {
        a.logEvent(name, params || {});
      }
    } catch {
      /* ignore */
    }
  }

  window.campaignLogEvent = campaignLogEvent;

  function shouldInitFirebaseAnalytics() {
    try {
      if (window.__FORCE_CAMPAIGN_ANALYTICS__ === false) return false;
      if (window.__FORCE_CAMPAIGN_ANALYTICS__ === true) return true;
      if (typeof sessionStorage !== "undefined" && sessionStorage.getItem("campaign_analytics_dev") === "1") {
        return true;
      }
    } catch {
      /* ignore */
    }

    var proto = window.location.protocol;
    if (proto === "file:") return false;

    var h = window.location.hostname;
    if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") return false;

    if (/^192\.168\./.test(h) || /^10\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return false;

    return true;
  }

  if (!shouldInitFirebaseAnalytics()) {
    return;
  }

  if (typeof firebase === "undefined") {
    return;
  }

  try {
    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }
    window.__campaignFirebaseAnalytics = firebase.analytics();
  } catch (e) {
    console.warn("[Campaign] Firebase Analytics unavailable:", e);
  }
})();
