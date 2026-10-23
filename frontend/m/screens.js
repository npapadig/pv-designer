// Screens of the mobile app: projects list, project (summary + map), documents.
(() => {
  "use strict";
  const S = window.M_SCREENS;
  let map = null;
  const dropMap = () => { if (map) { map.remove(); map = null; } };
  addEventListener("hashchange", dropMap);

  const lang = () => (window.I18N && I18N.lang === "en" ? "en-GB" : "el-GR");
  const fmtDate = (s) => { const d = new Date(s); return isNaN(d) ? "" : d.toLocaleDateString(lang()); };
  const num = (v, d = 1) => (v == null || v === "" || isNaN(v) ? null : Number(v).toLocaleString(lang(), { maximumFractionDigits: d }));

  // A polygon can come as [[lat, lng], ...] or as an object holding that list.
  function ring(p) {
    const pts = Array.isArray(p) ? p : p && (p.polygon || p.coords || p.points || p.latlngs);
    return Array.isArray(pts) ? pts.filter((q) => Array.isArray(q) && q.length >= 2) : [];
  }

  // ---------------------------------------------------------------- projects list
  S.projects = async (_, c) => {
    const { api, h, setView, setBar, spinner, errorBox, logout } = c;
    setBar({ title: "Έργα" });
    setView(spinner());
    let list;
    try { list = await api("/projects"); }
    catch (e) { if (e.status !== 401) setView(errorBox(e.message, () => S.projects(_, c))); return; }

    const box = h("div", { class: "cards" });
    const search = h("input", { type: "search", placeholder: "Αναζήτηση έργου…", "aria-label": "Αναζήτηση έργου" });
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const hit = list.filter((p) => !q || [p.name, p.client, p.address].some((x) => (x || "").toLowerCase().includes(q)));
      box.replaceChildren(...(hit.length ? hit.map((p) => card(p, h)) : [h("p", { class: "muted" },
        list.length ? "Κανένα έργο δεν ταιριάζει." : "Δεν υπάρχουν ακόμα έργα. Φτιάξε το πρώτο στον υπολογιστή.")]));
    };
    search.addEventListener("input", draw);
    draw();
    const refresh = h("button", { class: "big ghost", type: "button", onclick: () => S.projects(_, c) }, "Ανανέωση");
    setView(h("div", { class: "searchbar" }, search), box,
      h("div", { class: "pad" }, refresh, h("button", { class: "big ghost logout", type: "button", onclick: logout }, "Αποσύνδεση")));
    pullToRefresh(() => S.projects(_, c));
  };

  function card(p, h) {
    const chips = [num(p.kwp, 2) && num(p.kwp, 2) + " kWp", p.panels != null && p.panels + " πάνελ", fmtDate(p.updated)].filter(Boolean);
    return h("div", { class: "card", role: "link", tabindex: "0", onclick: () => { location.hash = "#/project/" + encodeURIComponent(p.id); },
      onkeydown: (e) => { if (e.key === "Enter") location.hash = "#/project/" + encodeURIComponent(p.id); } },
      h("h3", {}, p.name || "Χωρίς όνομα"),
      h("div", { class: "meta" }, [p.client, p.address].filter(Boolean).join(" · ")),
      h("div", { class: "chips" }, chips.map((t) => h("span", { class: "chip" }, t))));
  }

  // Pull down at the top of the list to reload it.
  function pullToRefresh(reload) {
    const v = document.getElementById("view");
    let y0 = null;
    v.ontouchstart = (e) => { y0 = v.scrollTop === 0 ? e.touches[0].clientY : null; };
    v.ontouchend = (e) => {
      if (y0 != null && e.changedTouches[0].clientY - y0 > 90) reload();
      y0 = null;
    };
  }

  // ---------------------------------------------------------------- project: summary + map
  S.project = async ([id], c) => {
    const { api, h, setView, setBar, spinner, errorBox } = c;
    setBar({ title: "Έργο", back: "#/" });
    setView(spinner());
    let p;
    try { p = await api("/projects/" + encodeURIComponent(id)); }
    catch (e) { if (e.status !== 401) setView(errorBox(e.message, () => S.project([id], c))); return; }
    setBar({ title: p.name || "Χωρίς όνομα", back: "#/" });

    const L = p.layout || {};
    const e = p.energy || {};
    const facts = [
      ["Ισχύς", num(L.kwp, 2) && num(L.kwp, 2) + " kWp"],
      ["Πάνελ", L.count != null ? String(L.count) : null],
      ["Ετήσια παραγωγή", num(e.annual_kwh, 0) && num(e.annual_kwh, 0) + " kWh"],
      ["Πελάτης", p.client], ["Διεύθυνση", p.address], ["Ενημερώθηκε", fmtDate(p.updated)],
    ].filter(([, v]) => v);
    const mapDiv = h("div", { id: "map", class: "map" });
    setView(
      h("div", { class: "facts" }, facts.map(([k, v]) => h("div", {}, h("span", { class: "muted" }, k), h("b", {}, v)))),
      mapDiv,
      h("div", { class: "pad" }, h("a", { class: "big", href: "#/docs/" + encodeURIComponent(id) }, "Έγγραφα PDF")));
    drawMap(mapDiv, p);
  };

  function drawMap(div, p) {
    dropMap();
    if (!window.L) { div.append(document.createTextNode("Ο χάρτης δεν φορτώθηκε.")); return; }
    map = L.map(div, { zoomControl: true, attributionControl: true, maxZoom: 21 });
    const esri = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxNativeZoom: 19, maxZoom: 21, attribution: "Esri, Maxar, Earthstar Geographics" });
    const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxNativeZoom: 19, maxZoom: 21, attribution: "© OpenStreetMap" });
    esri.addTo(map);
    const base = { "Δορυφορικός": esri, "Χάρτης (OSM)": osm };
    L.control.layers(base, null, { collapsed: true }).addTo(map);
    const group = L.featureGroup().addTo(map);
    const add = (polys, style) => (polys || []).forEach((poly) => {
      const r = ring(poly);
      if (r.length > 2) L.polygon(r, { weight: 2, ...style }).addTo(group);
    });
    add(p.areas, { color: "#ffc53d", fillOpacity: 0.12 });
    add(p.keepouts, { color: "#ff4d4d", fillColor: "#ff4d4d", fillOpacity: 0.35 });
    add((p.layout || {}).panels, { color: "#7cc4ff", weight: 1, fillColor: "#2f7bff", fillOpacity: 0.7 });
    if (group.getLayers().length) map.fitBounds(group.getBounds(), { padding: [20, 20] });
    else map.setView([38, 23.7], 6);
    setTimeout(() => map && map.invalidateSize(), 0);
  }
  // ---------------------------------------------------------------- documents (PDF)
  S.docs = async ([id], c) => {
    const { api, h, setView, setBar, spinner, errorBox } = c;
    const back = "#/project/" + encodeURIComponent(id);
    setBar({ title: "Έγγραφα", back });
    setView(spinner());
    let docs;
    try { docs = await api("/projects/" + encodeURIComponent(id) + "/documents"); }
    catch (e) { if (e.status !== 401) setView(errorBox(e.message, () => S.docs([id], c))); return; }

    let pdfLang = window.I18N && I18N.lang === "en" ? "en" : "el";
    const langBtns = [["el", "Ελληνικά"], ["en", "English"]].map(([code, label]) => {
      const b = h("button", { type: "button", "aria-pressed": String(code === pdfLang), translate: "no", onclick: () => {
        pdfLang = code; langBtns.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      } }, label);
      return b;
    });
    const rows = docs.map((d) => {
      const msg = h("p", { class: "err", role: "alert" });
      const act = (how) => async (ev) => {
        const btn = ev.currentTarget;
        msg.textContent = ""; btn.disabled = true;
        // Open the tab now (a click is needed for the phone to allow it), fill it when the PDF is ready.
        const w = how === "open" ? window.open("", "_blank") : null;
        try {
          const res = await api("/projects/" + encodeURIComponent(id) + "/documents/" + encodeURIComponent(d.kind) + "?lang=" + pdfLang, { raw: true });
          const url = URL.createObjectURL(new Blob([await res.blob()], { type: "application/pdf" }));
          if (w) w.location = url;
          else {
            const a = h("a", { href: url, download: (d.title || d.kind) + ".pdf" });
            document.body.append(a); a.click(); a.remove();
          }
          setTimeout(() => URL.revokeObjectURL(url), 120000);
        } catch (e) { if (w) w.close(); msg.textContent = e.message; }
        btn.disabled = false;
      };
      return h("div", { class: "card doc" }, h("h3", {}, d.title || d.kind),
        d.available ? null : h("p", { class: "muted" }, d.reason || "Δεν είναι διαθέσιμο ακόμα."),
        h("div", { class: "row" },
          h("button", { class: "big", type: "button", disabled: !d.available, onclick: act("open") }, "Άνοιγμα"),
          h("button", { class: "big ghost", type: "button", disabled: !d.available, onclick: act("save") }, "Λήψη")),
        msg);
    });
    setView(h("div", { class: "pad" }, h("p", { class: "muted" }, "Γλώσσα του PDF"), h("div", { class: "seg" }, langBtns)),
      h("div", { class: "cards" }, rows.length ? rows : [h("p", { class: "muted" }, "Δεν υπάρχουν έγγραφα.")]));
  };
})();
