// Ready-made layout proposals (economic / maximum energy / aesthetic, each with the tilt that fits the
// most panels) and a "manual" card with the settings as they are, shown as cards in the "Πάνελ" step; a click applies one to the map and copies its values into the settings above, so it
// stays editable. Loaded after app.js and faces.js; uses their areas, keepouts, latlngsOf, settings,
// setLayout, api, fmt and state.
(() => {
  const box = $("layoutOptions");
  const FACE_COLORS = ["#2563eb", "#14b8a6"]; // east, west (preview only)
  let shown = [];
  let chosen = null;

  // East-west mode lives in a checkbox that only makes sense with racks.
  function syncEw() {
    const rack = $("mounting").value === "rack";
    $("ewRow").hidden = !rack;
    $("azimuth").disabled = rack && $("ewMode").checked;
  }
  $("mounting").addEventListener("change", syncEw);
  $("ewMode").addEventListener("change", () => { syncEw(); clearLayout(); });
  syncEw();

  // Small top-down drawing of the areas and the panels of one proposal (north up).
  function preview(opt, outlines) {
    const all = outlines.flat().concat(opt.panels.flat());
    if (!all.length) return "";
    const lat0 = all.reduce((a, p) => a + p[0], 0) / all.length;
    const k = Math.cos((lat0 * Math.PI) / 180);
    const xy = (p) => [p[1] * k, -p[0]];
    const pts = all.map(xy);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const w = Math.max(...xs) - minX || 1e-9, h = Math.max(...ys) - minY || 1e-9;
    const s = 100 / Math.max(w, h);
    const path = (poly) => poly.map((p) => xy(p)).map(([x, y]) => `${((x - minX) * s).toFixed(1)},${((y - minY) * s).toFixed(1)}`).join(" ");
    const areaSvg = outlines.map((a) => `<polygon class="opt-area" points="${path(a)}"/>`).join("");
    const panelSvg = opt.panels.map((p, i) =>
      `<polygon points="${path(p)}" fill="${FACE_COLORS[opt.panel_face ? opt.panel_face[i] : 0]}"/>`).join("");
    return `<svg viewBox="-3 -3 ${(w * s + 6).toFixed(1)} ${(h * s + 6).toFixed(1)}" preserveAspectRatio="xMidYMid meet">${areaSvg}${panelSvg}</svg>`;
  }

  function angles(o) {
    const dir = o.key === "east_west" || o.east_west ? "Α/Δ" : `${fmt(o.azimuth_deg)}°`;
    return `<em>Κλίση ${fmt(o.tilt_deg)}°</em> · ${dir}`;
  }

  function render(outlines) {
    const best = Math.max(...shown.map((o) => o.kwp || 0));
    const cards = shown.map((o, i) => `
      <button type="button" class="opt-card${chosen === o.key ? " chosen" : ""}" data-i="${i}" ${o.count ? "" : "disabled"}>
        <b>${o.title}</b>
        <span class="opt-note">${o.note}</span>
        <span class="opt-preview">${preview(o, outlines)}</span>
        <span class="opt-angles">${angles(o)}</span>
        <span class="opt-num"><em>${fmt(o.count)}</em> πάνελ</span>
        <span class="opt-num${o.kwp && o.kwp === best ? " best" : ""}"><em>${o.count ? fmt(o.kwp, 2) : "–"}</em> kWp</span>
        ${o.count ? "" : `<span class="opt-num small">δεν χωράει</span>`}
      </button>`).join("");
    box.innerHTML = `<h3>Προτάσεις διάταξης</h3>
      <div class="opt-cards">${cards}</div>
      <p class="muted small">Κάνε κλικ σε μία για να μπει στον χάρτη. Στις 3 πρώτες η κλίση είναι αυτή που χωράει
        τα περισσότερα πάνελ χωρίς σκίαση τον χειμώνα. Οι τιμές περνούν στις ρυθμίσεις παραπάνω, οπότε μπορείς
        να τις αλλάξεις· η κάρτα «Χειροκίνητα» δείχνει τις ρυθμίσεις όπως είναι. Η παραγωγή υπολογίζεται
        στο βήμα «Παραγωγή», για την πρόταση που θα διαλέξεις.</p>`;
    box.querySelectorAll(".opt-card").forEach((b) => (b.onclick = () => apply(shown[+b.dataset.i])));
  }

  function apply(o) {
    const ew = o.key === "east_west" || !!o.east_west;
    $("tilt").value = o.tilt_deg;
    if (!ew) $("azimuth").value = Math.round(o.azimuth_deg);
    $("mounting").value = o.mounting;
    $("rowGap").value = o.row_spacing_m == null ? "" : o.row_spacing_m;
    $("ewMode").checked = ew;
    syncEw();
    const { panels, key, title, note, east_west, ...res } = o;
    setLayout(panels, res);
    chosen = key;
    box.querySelectorAll(".opt-card").forEach((b) => b.classList.toggle("chosen", shown[+b.dataset.i].key === key));
    toast(`Επιλέχθηκε: ${title}. ${fmt(o.count)} πάνελ, ${fmt(o.kwp, 2)} kWp.`);
  }

  async function show() {
    const areaLayers = areas.getLayers();
    if (!areaLayers.length) throw new Error("Σχεδίασε πρώτα μια περιοχή στον χάρτη.");
    // A pitched roof already split into faces: panels lie on each face, the proposals do not apply.
    if (window.faces?.active()) {
      box.innerHTML = `<p class="muted small">Η στέγη είναι χωρισμένη σε πλευρές, οπότε τα πάνελ μπαίνουν
        παράλληλα πάνω σε κάθε πλευρά, με τη δική της κλίση και προσανατολισμό. Οι έτοιμες προτάσεις
        (βάσεις νότια, ανατολή-δύση, παράλληλα με τον τοίχο) είναι για επίπεδες ταράτσες και έδαφος.</p>`;
      return runLayout();
    }
    const s = settings();
    const outlines = areaLayers.map(latlngsOf);
    box.innerHTML = `<p class="muted small">Υπολογισμός των προτάσεων…</p>`;
    try {
      const r = await api("/api/layout/options", "POST", {
        ...s, areas: outlines, keepouts: keepouts.getLayers().map(latlngsOf), east_west: window.options.eastWest(),
      });
      shown = r.options;
    } catch (e) {
      box.innerHTML = "";
      throw e;
    }
    chosen = null;
    render(outlines);
  }

  window.options = {
    show,
    // True when the east-west mode is on (racks, rows facing east and west in turn).
    eastWest: () => $("mounting").value === "rack" && $("ewMode").checked,
  };
})();
