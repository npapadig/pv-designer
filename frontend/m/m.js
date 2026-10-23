// PV Designer mobile (read only): login, projects, project map, documents. Plain JS, no build step.
// Texts are written in Greek; ../i18n.js translates the page when the language is English.
// Add ?mock=1 to the address to work with made-up data (no server needed).
(() => {
  "use strict";
  const TOKEN_KEY = "pv-designer.m.token";
  const THEME_KEY = "pv-designer.theme";
  const MOCK = /[?&]mock=1/.test(location.search);
  const $ = (id) => document.getElementById(id);
  const tr = (s) => (window.I18N ? I18N.t(s) : s);
  const view = $("view");

  // ---------------------------------------------------------------- storage (can throw in private mode)
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  // ---------------------------------------------------------------- small helpers
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  }
  function setView(...nodes) { view.replaceChildren(...nodes); view.scrollTop = 0; }
  function setBar({ title, back } = {}) {
    $("bar").hidden = title == null;
    $("title").textContent = title ?? "";
    $("back").hidden = !back;
    $("back").onclick = back ? () => { location.hash = back; } : null;
  }
  const spinner = () => h("div", { class: "spin" }, "Φόρτωση…");
  function errorBox(msg, retry) {
    return h("div", { class: "pad" }, h("p", { class: "err" }, msg),
      retry ? h("button", { class: "big ghost", type: "button", onclick: retry }, "Δοκίμασε ξανά") : null);
  }

  // ---------------------------------------------------------------- the server (or the mock)
  class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }

  async function api(path, opts = {}) {
    if (MOCK) return window.MOCK_API(path, opts);
    const headers = { ...(opts.headers || {}) };
    const token = store.get(TOKEN_KEY);
    if (token) headers.Authorization = "Bearer " + token;
    if (opts.json) { headers["Content-Type"] = "application/json"; opts = { ...opts, body: JSON.stringify(opts.json) }; }
    let res;
    try { res = await fetch("/api/m" + path, { ...opts, headers }); }
    catch { setOffline(true); throw new ApiError(0, "Δεν υπάρχει σύνδεση με τον υπολογιστή."); }
    setOffline(false);
    if (res.status === 401 && path !== "/login") { store.del(TOKEN_KEY); route(); throw new ApiError(401, "Η σύνδεση έληξε. Συνδέσου ξανά."); }
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).detail || ""; } catch {}
      throw new ApiError(res.status, typeof detail === "string" && detail ? detail
        : res.status === 429 ? "Πολλές προσπάθειες. Περίμενε λίγο και δοκίμασε ξανά." : "Κάτι πήγε στραβά (" + res.status + ").");
    }
    return opts.raw ? res : res.json();
  }
  function setOffline(off) { $("offline").hidden = !off; }
  addEventListener("online", () => setOffline(false));
  addEventListener("offline", () => setOffline(true));

  // ---------------------------------------------------------------- screens
  async function loginScreen() {
    setBar();
    setView(spinner());
    let status;
    try { status = await api("/status"); }
    catch (e) { setView(errorBox(e.message, loginScreen)); return; }

    const logo = h("img", { class: "logo", src: "icon.svg", alt: "" });
    if (!status.enabled) {
      setView(h("div", { class: "center" }, logo, h("h2", {}, "Το Κινητό είναι απενεργοποιημένο"),
        h("p", { class: "muted" }, "Άνοιξε την εφαρμογή στον υπολογιστή και ενεργοποίησε το «Κινητό» από την αρχική οθόνη."),
        h("button", { class: "big ghost", type: "button", onclick: loginScreen }, "Δοκίμασε ξανά")));
      return;
    }
    if (status.needs_password) {
      setView(h("div", { class: "center" }, logo, h("h2", {}, "Δεν έχει οριστεί κωδικός"),
        h("p", { class: "muted" }, "Όρισε κωδικό για το «Κινητό» στην εφαρμογή του υπολογιστή και ξαναδοκίμασε."),
        h("button", { class: "big ghost", type: "button", onclick: loginScreen }, "Δοκίμασε ξανά")));
      return;
    }
    const pw = h("input", { type: "password", placeholder: "Κωδικός", autocomplete: "current-password", "aria-label": "Κωδικός" });
    const msg = h("p", { class: "err", role: "alert" });
    const btn = h("button", { class: "big", type: "submit" }, "Σύνδεση");
    const form = h("form", { class: "center", onsubmit: async (ev) => {
      ev.preventDefault();
      msg.textContent = ""; btn.disabled = true;
      try {
        const r = await api("/login", { method: "POST", json: { password: pw.value } });
        store.set(TOKEN_KEY, r.token);
        location.hash = "#/";
        route();
      } catch (e) {
        msg.textContent = e.status === 401 ? "Λάθος κωδικός." : e.message;
        btn.disabled = false; pw.select();
      }
    } }, logo, h("h2", {}, "PV Designer"), h("p", { class: "muted" }, "Βάλε τον κωδικό που όρισες στον υπολογιστή."), pw, msg, btn);
    setView(form);
  }

  async function logout() {
    try { await api("/logout", { method: "POST" }); } catch {}
    store.del(TOKEN_KEY);
    location.hash = "#/";
    route();
  }

  // Screens added by the next steps register themselves here.
  const screens = window.M_SCREENS = {};

  // ---------------------------------------------------------------- router
  function route() {
    if (!store.get(TOKEN_KEY)) { loginScreen(); return; }
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    const fn = screens[parts[0] || "projects"];
    if (fn) fn(parts.slice(1), { api, h, setView, setBar, spinner, errorBox, tr, logout, store });
    else { location.hash = "#/"; }
  }
  addEventListener("hashchange", route);

  // ---------------------------------------------------------------- top bar buttons
  $("theme").onclick = () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    store.set(THEME_KEY, next);
  };
  const langBtn = $("lang");
  const showLang = () => { langBtn.textContent = window.I18N && I18N.lang === "en" ? "ΕΛ" : "EN"; };
  langBtn.onclick = () => { if (window.I18N) { I18N.setLang(I18N.lang === "en" ? "el" : "en"); showLang(); } };
  showLang();

  window.addEventListener("DOMContentLoaded", route);
  if (document.readyState !== "loading") route();
  window.M = { api, logout };
})();
