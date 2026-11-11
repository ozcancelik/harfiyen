// Shared script for the site pages, loaded in <head> so the theme and language are set before the first paint.
(function () {
  var root = document.documentElement;

  // The app's saved theme (src/lib/theme.ts).
  try {
    var t = localStorage.getItem("harfiyen.theme");
    var light = t === "light" || (t !== "dark" && matchMedia("(prefers-color-scheme: light)").matches);
    root.dataset.theme = light ? "light" : "dark";
  } catch (e) {}

  // Pages written in both languages (<html data-i18n>) show one at a time: #en / #tr in the link,
  // then the last choice, then the browser's language.
  if (!root.hasAttribute("data-i18n")) return;
  var KEY = "harfiyen.siteLang";
  var pick = function () {
    var h = location.hash.slice(1);
    if (h === "en" || h === "tr") return h;
    try {
      var s = localStorage.getItem(KEY);
      if (s === "en" || s === "tr") return s;
    } catch (e) {}
    return /^tr\b/i.test(navigator.language || "") ? "tr" : "en";
  };
  var titles = { tr: document.title, en: "" };
  var apply = function (lang) {
    root.dataset.lang = lang;
    root.lang = lang;
    if (titles.en) document.title = titles[lang];
    document.querySelectorAll(".langs button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
    });
  };
  apply(pick());

  document.addEventListener("DOMContentLoaded", function () {
    titles.tr = root.dataset.titleTr || document.title;
    titles.en = root.dataset.titleEn || "";
    apply(root.dataset.lang);
    document.querySelectorAll(".langs button").forEach(function (b) {
      b.addEventListener("click", function () {
        apply(b.dataset.lang);
        try {
          localStorage.setItem(KEY, b.dataset.lang);
        } catch (e) {}
        history.replaceState(null, "", "#" + b.dataset.lang);
      });
    });
  });
  addEventListener("hashchange", function () {
    var h = location.hash.slice(1);
    if (h === "en" || h === "tr") apply(h);
  });
})();
