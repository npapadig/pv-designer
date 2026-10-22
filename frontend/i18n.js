// Greek / English. The app is written in Greek; in English this file translates what the page shows, with the
// dictionary in lang/en.js (Greek text -> English): text on the page, the title / placeholder / aria-label / alt
// of elements, toasts, confirm/alert/prompt, chart labels, the name of the downloaded report. A MutationObserver
// also catches everything that the other scripts create later (cards, popups, results).
// In Greek nothing is touched: the page stays exactly as the other files make it.
// Loaded in <head>, before the other scripts. window.I18N = { lang, t(text), setLang(lang) }.
(() => {
  const KEY = "pv-designer.lang";
  const GREEK = /[Ͱ-Ͽἀ-῿]/;
  const ATTRS = ["title", "placeholder", "aria-label", "alt"];
  const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "NOSCRIPT"]);
  const dict = window.I18N_EN || { texts: {}, rules: [], parts: [] };
  const rules = dict.rules.map(([p, r]) => [new RegExp(p), r]);
  const parts = dict.parts.map(([p, r]) => [new RegExp(p, "g"), r]);

  let lang = "el";
  try { if (localStorage.getItem(KEY) === "en") lang = "en"; } catch {}

  // ---------------------------------------------------------------- translating one text
  const cache = new Map();

  // English of a text, or null. Spaces around it are kept; inside it they count as one.
  function translate(text) {
    if (!GREEK.test(text) && !Object.prototype.hasOwnProperty.call(dict.texts, text.trim())) return null;
    if (cache.has(text)) return cache.get(text);
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    let out = english(core.replace(/\s+/g, " "));
    if (out == null) {
      // A decoration in front ("✅ ", "• ") is kept as it is.
      const deco = /^[^\p{L}\p{N}«“"'(\[+\-−–]+/u.exec(core);
      if (deco) {
        const rest = english(core.slice(deco[0].length).replace(/\s+/g, " "));
        if (rest != null) out = deco[0] + rest;
      }
    }
    const res = out == null ? null : lead + out + trail;
    if (cache.size > 5000) cache.clear();
    cache.set(text, res);
    return res;
  }

  function english(s) {
    if (Object.prototype.hasOwnProperty.call(dict.texts, s)) return dict.texts[s];
    for (const [re, repl] of rules) {
      const m = re.exec(s);
      if (m) return repl.replace(/\$(\d)/g, (_, i) => { const g = m[+i] ?? ""; return translate(g) ?? g; });
    }
    let t = s;
    for (const [re, repl] of parts) t = t.replace(re, repl);
    return t !== s && !GREEK.test(t) ? t : null;
  }

  const t = (text) => (lang === "en" && typeof text === "string" ? translate(text) ?? text : text);

  // ---------------------------------------------------------------- the page
  const textOrig = new WeakMap(); // text node -> { src: Greek, out: English }
  const attrOrig = new WeakMap(); // element -> { attribute: { src, out } }

  function skipped(el) {
    return el && (SKIP.has(el.nodeName) || el.isContentEditable || el.closest?.('[translate="no"]'));
  }

  function doText(node) {
    const st = textOrig.get(node);
    const cur = node.data;
    if (st && cur === st.out) {
      if (lang === "el") { textOrig.delete(node); node.data = st.src; }
      return;
    }
    textOrig.delete(node);
    if (lang !== "en" || skipped(node.parentElement)) return;
    const out = translate(cur);
    if (out != null && out !== cur) { textOrig.set(node, { src: cur, out }); node.data = out; }
  }

  function doAttr(el, name) {
    const all = attrOrig.get(el);
    const st = all && all[name];
    const cur = el.getAttribute(name);
    if (cur == null) return;
    if (st && cur === st.out) {
      if (lang === "el") { delete all[name]; el.setAttribute(name, st.src); }
      return;
    }
    if (all) delete all[name];
    if (lang !== "en" || skipped(el)) return;
    const out = translate(cur);
    if (out != null && out !== cur) {
      if (all) all[name] = { src: cur, out }; else attrOrig.set(el, { [name]: { src: cur, out } });
      el.setAttribute(name, out);
    }
  }

  function doElement(el) {
    for (const a of ATTRS) if (el.hasAttribute(a)) doAttr(el, a);
    if (el.nodeName === "INPUT" && /^(button|submit|reset)$/.test(el.type)) doAttr(el, "value");
  }

  function walk(root) {
    if (root.nodeType === Node.TEXT_NODE) return doText(root);
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE) {
      if (SKIP.has(root.nodeName)) return;
      doElement(root);
    }
    const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = it.nextNode(); n; n = it.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) doText(n); else doElement(n);
    }
  }

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") doText(r.target);
      else if (r.type === "attributes") doAttr(r.target, r.attributeName);
      else r.addedNodes.forEach(walk);
    }
  });

  function observe(on) {
    if (on) {
      observer.observe(document.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: [...ATTRS, "value"],
      });
    } else {
      observer.disconnect();
    }
  }

  // ---------------------------------------------------------------- things that are not on the page
  // Numbers and dates: the scripts ask for "el-GR"; in English they get "en-GB".
  for (const [proto, names] of [[Number.prototype, ["toLocaleString"]],
    [Date.prototype, ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]]]) {
    for (const name of names) {
      const orig = proto[name];
      proto[name] = function (locales, options) {
        return orig.call(this, lang === "en" && locales === "el-GR" ? "en-GB" : locales, options);
      };
    }
  }

  // Questions and messages in browser dialogs.
  for (const name of ["alert", "confirm", "prompt"]) {
    const orig = window[name];
    window[name] = function (message, ...rest) { return orig.call(this, t(message), ...rest); };
  }

  // The file name of a download (the PDF report).
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (lang === "en" && this.download) this.download = t(this.download);
    return click.call(this);
  };

  // Chart labels are drawn on a canvas: translate the chart's own settings (keeping the Greek ones) when it is
  // made and when the language changes.
  const chartOrig = new WeakMap(); // settings object -> { key: { src, out } }
  function swap(obj, key) {
    if (!obj || obj[key] == null) return;
    const all = chartOrig.get(obj) || {};
    const st = all[key];
    if (lang === "el" && !st) return;
    const src = st && obj[key] === st.out ? st.src : obj[key];
    const out = Array.isArray(src) ? src.map(t) : t(src);
    all[key] = { src, out };
    chartOrig.set(obj, all);
    obj[key] = out;
  }
  function translateChart(chart) {
    const { data, options } = chart.config;
    swap(data, "labels");
    (data.datasets || []).forEach((d) => swap(d, "label"));
    Object.values((options && options.scales) || {}).forEach((s) => swap(s.title, "text"));
  }
  const chartPlugin = { id: "i18n", beforeInit: translateChart };

  // The default name of a new project is a text of the app too.
  function projectName() {
    const el = document.getElementById("projectName");
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (!el || Object.prototype.hasOwnProperty.call(el, "value")) return;
    const NAMES = { "Νέο έργο": "New project" };
    const back = Object.fromEntries(Object.entries(NAMES).map(([k, v]) => [v, k]));
    Object.defineProperty(el, "value", {
      configurable: true,
      get() { return desc.get.call(el); },
      set(v) { desc.set.call(el, lang === "en" ? NAMES[v] ?? v : v); },
    });
    el.$i18nSwap = () => {
      const v = desc.get.call(el);
      if (lang === "en" && NAMES[v]) desc.set.call(el, NAMES[v]);
      if (lang === "el" && back[v]) desc.set.call(el, back[v]);
    };
    el.$i18nSwap();
  }

  // ---------------------------------------------------------------- the ΕΛ / EN switch
  const FLAGS = {
    el: `<svg class="flag" viewBox="0 0 27 18" aria-hidden="true"><rect width="27" height="18" fill="#0d5eaf"/>` +
      `<path d="M10 3h17M10 7h17M0 11h27M0 15h27" stroke="#fff" stroke-width="2"/>` +
      `<path d="M0 5h10M5 0v10" stroke="#fff" stroke-width="2"/></svg>`,
    en: `<svg class="flag" viewBox="0 0 60 30" aria-hidden="true"><clipPath id="flagUk"><path d="M0 0v30h60V0z"/></clipPath>` +
      `<g clip-path="url(#flagUk)"><path d="M0 0v30h60V0z" fill="#012169"/>` +
      `<path d="M0 0l60 30m0-30L0 30" stroke="#fff" stroke-width="6"/>` +
      `<path d="M0 0l60 30m0-30L0 30" stroke="#c8102e" stroke-width="2"/>` +
      `<path d="M30 0v30M0 15h60" stroke="#fff" stroke-width="10"/>` +
      `<path d="M30 0v30M0 15h60" stroke="#c8102e" stroke-width="6"/></g></svg>`,
  };

  function switcher() {
    const box = document.createElement("div");
    box.className = "lang-switch";
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Γλώσσα / Language");
    box.setAttribute("translate", "no");
    for (const [code, label, title] of [["el", "ΕΛ", "Ελληνικά"], ["en", "EN", "English"]]) {
      const b = document.createElement("button");
      b.type = "button";
      // Drawn flags: Windows shows emoji flags as plain letters.
      b.innerHTML = FLAGS[code];
      b.append(label);
      b.title = title;
      b.dataset.lang = code;
      b.setAttribute("aria-pressed", String(code === lang));
      b.onclick = () => setLang(code);
      box.append(b);
    }
    return box;
  }

  function placeSwitches() {
    const spots = [["homeTheme", ".home-head"], ["btnHomeSheet", ".panel-head"]];
    for (const [beforeId, parentSel] of spots) {
      const before = document.getElementById(beforeId);
      const parent = before ? before.parentElement : document.querySelector(parentSel);
      if (parent && !parent.querySelector(".lang-switch")) parent.insertBefore(switcher(), before);
    }
  }

  function setLang(code) {
    code = code === "en" ? "en" : "el";
    if (code === lang) return;
    lang = code;
    try { localStorage.setItem(KEY, code); } catch {}
    document.documentElement.lang = code;
    document.querySelectorAll(".lang-switch button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === code)));
    walk(document);
    observe(code === "en");
    document.getElementById("projectName")?.$i18nSwap?.();
    if (window.Chart && Chart.instances) Object.values(Chart.instances).forEach((c) => { translateChart(c); c.update(); });
  }

  window.I18N = { get lang() { return lang; }, t, setLang };

  if (lang === "en") {
    document.documentElement.lang = "en";
    observe(true);
  }
  document.addEventListener("DOMContentLoaded", () => {
    if (window.Chart && Chart.register) Chart.register(chartPlugin);
    projectName();
    placeSwitches();
    if (lang === "en") walk(document);
  });
})();
