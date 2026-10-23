// Electrical design (inverters, strings) and the detailed simulation's loss breakdown.
// Loaded after app.js and uses its helpers ($, api, state, settings, toast, withBusy, fmt).

const INV_FIELDS = {
  invPac: ["pac_w", 1000], invPdc: ["pdc_max_w", 1000], invPhases: ["phases", 1], invVdc: ["vdc_max", 1],
  invVmin: ["v_mppt_min", 1], invVmax: ["v_mppt_max", 1], invVstart: ["v_start", 1], invMppt: ["n_mppt", 1],
  invSpm: ["strings_per_mppt", 1], invImax: ["i_max_mppt", 1], invIsc: ["isc_max_mppt", 1], invEff: ["eff_pct", 1],
};
const ELEC_INPUTS = [
  "invPreset", "invCount", "modsPerString", "dcAcTarget", "tMin", "tMax", "phases",
  "modVoc", "modIsc", "modVmp", "modImp", "modBetaVoc", "modGammaP", ...Object.keys(INV_FIELDS),
  "energyMethod", "lSoiling", "lMismatch", "lQuality", "lDc", "lAc", "lAvail",
];
let inverterLibrary = [];

const elec = {
  detailed: () => $("energyMethod").value === "detailed",

  reset() {
    state.electrical = null;
    renderDesign();
  },

  collect() {
    const inputs = {};
    ELEC_INPUTS.forEach((id) => (inputs[id] = $(id).value));
    inputs.mixFaces = $("mixFaces").checked;
    const design = state.electrical || null;
    return { inputs, design, report: design ? design.report : null };
  },

  load(saved) {
    if (!saved) return;
    Object.entries(saved.inputs || {}).forEach(([id, v]) => { if ($(id) && v != null && id !== "mixFaces") $(id).value = v; });
    $("mixFaces").checked = !!(saved.inputs || {}).mixFaces;
    toggleLossInputs();
    state.electrical = saved.design || null;
    renderDesign();
  },

  async simulate() {
    if (!state.electrical) await runDesign();
    const d = state.electrical;
    if (!d.ok) toast("Προσοχή: ο σχεδιασμός strings έχει σφάλματα (δες την ενότητα 5).", 6000);
    const s = settings();
    const [lat, lon] = state.layout.center;
    return api("/api/simulate", "POST", {
      lat, lon, tilt_deg: s.tilt_deg, azimuth_deg: s.azimuth_deg, mounting: s.mounting,
      dc_kwp: d.dc_kwp, ac_kw: d.ac_kw, inverter_eff_pct: d.inverter.eff_pct,
      temp_coeff_pmax_pct: +$("modGammaP").value,
      soiling_pct: +$("lSoiling").value, mismatch_pct: +$("lMismatch").value, module_quality_pct: +$("lQuality").value,
      dc_wiring_pct: +$("lDc").value, ac_wiring_pct: +$("lAc").value, availability_pct: +$("lAvail").value,
      shading_monthly_pct: state.shading ? state.shading.monthly_loss_pct : null,
      // With strings per face, each face brings the power of its connected panels.
      faces: (window.faces?.energyFaces() || null)?.map((f, i) => (d.faces ? { ...f, kwp: d.faces[i].dc_kwp } : f)) || null,
    });
  },

  render() {
    renderDesign();
    renderSummary();
    renderLosses();
  },
};
window.elec = elec;

// ---------- Inputs ----------
function fillModuleElectrics() {
  const p = PANEL_PRESETS[$("panelPreset").value];
  if (!p || !p.voc) return;
  $("modVoc").value = p.voc; $("modIsc").value = p.isc; $("modVmp").value = p.vmp; $("modImp").value = p.imp;
  if (p.betaVoc != null) { $("modBetaVoc").value = p.betaVoc; $("modGammaP").value = p.gammaP; }
}
$("panelPreset").addEventListener("change", () => { fillModuleElectrics(); elec.reset(); });
fillModuleElectrics();

function fillInverterFields(inv) {
  Object.entries(INV_FIELDS).forEach(([id, [key, scale]]) => ($(id).value = inv ? +(inv[key] / scale).toFixed(2) : ""));
}

function inverterFromFields() {
  const inv = { name: "Δικός μου inverter" };
  Object.entries(INV_FIELDS).forEach(([id, [key, scale]]) => (inv[key] = +$(id).value * scale));
  const sel = $("invPreset").value;
  if (sel !== "auto" && sel !== "custom") inv.name = inverterLibrary[sel].name;
  return inv;
}

function showInverterInfo() {
  const sel = $("invPreset").value;
  if (sel === "auto") {
    $("invInfo").textContent = "Η εφαρμογή δοκιμάζει όλους τους inverters και διαλέγει τον καταλληλότερο.";
  } else {
    const i = inverterFromFields();
    $("invInfo").textContent = `${fmt(i.pac_w / 1000, 1)} kW AC, ${i.phases === 1 ? "μονοφασικός" : "τριφασικός"}, ` +
      `μέγ. ${fmt(i.vdc_max)} V DC, MPPT ${fmt(i.v_mppt_min)}–${fmt(i.v_mppt_max)} V, ` +
      `${i.n_mppt} MPPT × ${i.strings_per_mppt} string, απόδοση ${fmt(i.eff_pct, 1)}%.`;
  }
}

$("invPreset").onchange = () => {
  const sel = $("invPreset").value;
  if (sel === "custom") $("invDetails").open = true;
  else fillInverterFields(sel === "auto" ? null : inverterLibrary[sel]);
  showInverterInfo();
  elec.reset();
};
Object.keys(INV_FIELDS).forEach((id) => $(id).addEventListener("input", () => {
  $("invPreset").value = "custom";
  showInverterInfo();
  elec.reset();
}));
["invCount", "modsPerString", "dcAcTarget", "tMin", "tMax", "phases", "modVoc", "modIsc", "modVmp", "modImp",
  "modBetaVoc", "mounting", "panelPower", "mixFaces"].forEach((id) => $(id).addEventListener("change", () => elec.reset()));

function toggleLossInputs() {
  $("lossSimple").hidden = elec.detailed();
  $("lossDetailed").hidden = !elec.detailed();
}
$("energyMethod").onchange = toggleLossInputs;
toggleLossInputs();

// Real panels from manufacturer datasheets. They go AFTER "Δικό μου" so the saved preset numbers of old projects stay valid.
api("/api/panels").then((list) => {
  list.forEach((p) => {
    PANEL_PRESETS.push({
      name: p.name, power: p.power_w, width: p.width_m, length: p.length_m, voc: p.voc, isc: p.isc, vmp: p.vmp, imp: p.imp,
      betaVoc: p.temp_coeff_voc_pct, gammaP: p.temp_coeff_pmax_pct,
    });
    $("panelPreset").add(new Option(p.name, PANEL_PRESETS.length - 1));
  });
}).catch(() => {});

api("/api/inverters").then((list) => {
  inverterLibrary = list;
  const sel = $("invPreset");
  const saved = sel.value;
  sel.length = 0;
  sel.add(new Option("Αυτόματη επιλογή (προτείνεται)", "auto"));
  list.forEach((inv, i) => sel.add(new Option(inv.name, i)));
  sel.add(new Option("Δικός μου (συμπληρώνω τα στοιχεία)", "custom"));
  sel.value = saved || "auto";
  showInverterInfo();
}).catch(() => {});

// ---------- Design ----------
async function runDesign() {
  if (!state.layout || !state.layout.count) await runLayout();
  if (!state.layout.count) throw new Error("Δεν υπάρχουν πάνελ για σύνδεση.");
  const num = (id) => ($(id).value === "" ? null : +$(id).value);
  const sel = $("invPreset").value;
  state.electrical = await api("/api/electrical", "POST", {
    module: {
      power_w: +$("panelPower").value, voc: +$("modVoc").value, isc: +$("modIsc").value,
      vmp: +$("modVmp").value, imp: +$("modImp").value,
      temp_coeff_voc_pct: +$("modBetaVoc").value, temp_coeff_pmax_pct: +$("modGammaP").value,
    },
    n_modules: state.layout.count,
    inverter: sel === "auto" ? null : inverterFromFields(),
    n_inverters: num("invCount"),
    modules_per_string: num("modsPerString"),
    t_min: +$("tMin").value, t_max: +$("tMax").value,
    mounting: $("mounting").value,
    dc_ac_target: +$("dcAcTarget").value,
    phases: $("phases").value,
    face_modules: state.layout.faces ? state.layout.faces.map((f) => f.count) : null,
    mix_faces: $("mixFaces").checked,
  });
  if (sel === "auto") fillInverterFields(state.electrical.inverter);
  state.energy = null;
  renderResults();
}
$("btnStrings").onclick = () => withBusy($("btnStrings"), runDesign);

const ICONS = { ok: "✅", warning: "⚠️", error: "⛔" };

function designHeadline(d) {
  const lengths = d.faces
    ? [...new Set(d.faces.filter((f) => f.strings).map((f) => f.modules_per_string))].join("/")
    : d.modules_per_string;
  return `${d.n_inverters} × ${d.inverter.name} · ${d.n_strings} string(s) των ${lengths} πάνελ · ` +
    `${fmt(d.dc_kwp, 2)} kWp DC / ${fmt(d.ac_kw, 1)} kW AC · DC/AC ${fmt(d.dc_ac_ratio, 2)}`;
}

function renderDesign() {
  const box = $("elecResult");
  const d = state.electrical;
  if (!d) { box.innerHTML = ""; return; }
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const side = (p, j) => (p.mppt_faces && p.mppt_faces[j].length
    ? ` (πλευρά ${p.mppt_faces[j].map((f) => f + 1).join(" + ")})` : "");
  const invRows = d.per_inverter.map((p, i) =>
    `<li>Inverter ${i + 1}: ${p.mppts.map((n, j) => `MPPT ${j + 1}: ${n} string${side(p, j)}`).join(", ")}</li>`).join("");
  const faceRows = d.faces ? d.faces.map((f, i) =>
    `<li>Πλευρά ${i + 1}: ${f.modules_used} από ${f.modules} πάνελ` +
    (f.strings ? ` σε ${f.strings} string των ${f.modules_per_string}, ${f.mppts} MPPT` : " (δεν συνδέονται)") + `</li>`).join("") : "";
  box.innerHTML = `
    <div class="elec-card ${d.ok ? "" : "bad"}">
      <strong>${esc(designHeadline(d))}</strong>
      <ul class="small">${invRows}</ul>
      ${faceRows ? `<ul class="small">${faceRows}</ul>` : ""}
      <p class="muted small">Τάση string: ${fmt(d.voltages.voc_cold)} V ανοιχτοκύκλωμα στο κρύο, λειτουργία
        ${fmt(d.voltages.vmp_hot)}–${fmt(d.voltages.vmp_cold)} V (κύτταρα ${fmt(d.temps.cell_max)} έως ${fmt(d.temps.cell_min)} °C).
        Επιτρεπτό μήκος string για αυτόν τον inverter: ${d.string_range.min}–${d.string_range.max} πάνελ.</p>
      <ul class="checks">${d.checks.map((c) => `<li class="${c.level}">${ICONS[c.level]} ${esc(c.text)}</li>`).join("")}</ul>
    </div>`;
}

function renderSummary() {
  const d = state.electrical;
  $("elecSummary").innerHTML = d
    ? `<p class="small"><strong>Ηλεκτρολογικά:</strong> ${designHeadline(d)}${d.ok ? "" : " (με σφάλματα)"}.</p>`
    : "";
}

function renderLosses() {
  const e = state.energy;
  const box = $("lossTable");
  if (!e || !e.loss_steps) { box.innerHTML = ""; return; }
  const maxPct = Math.max(...e.loss_steps.map((l) => Math.abs(l.pct)), 1);
  const rows = e.loss_steps.map((l) => `
    <tr><td>${l.label}</td>
      <td class="num">${l.pct >= 0 ? "−" : "+"}${fmt(Math.abs(l.pct), 1)}%</td>
      <td class="num">${fmt(l.kwh)} kWh</td>
      <td class="bar"><span style="width:${Math.max(0, (100 * l.pct) / maxPct)}%"></span></td></tr>`).join("");
  box.innerHTML = `
    <h3>Ανάλυση απωλειών</h3>
    <p class="muted small">Ακτινοβολία: ${fmt(e.annual_ghi)} kWh/m² στο οριζόντιο, ${fmt(e.annual_irradiation)} kWh/m²
      στο επίπεδο των πάνελ (${e.transposition_gain_pct >= 0 ? "+" : ""}${fmt(e.transposition_gain_pct, 1)}%).</p>
    <table class="losses">
      <tr class="total"><td>Ονομαστική ενέργεια πάνελ</td><td></td><td class="num">${fmt(e.nominal_kwh)} kWh</td><td></td></tr>
      ${rows}
      <tr class="total"><td>Ενέργεια στο δίκτυο</td><td class="num">PR ${fmt(e.performance_ratio * 100, 1)}%</td>
        <td class="num">${fmt(e.annual_kwh)} kWh</td><td></td></tr>
    </table>
    <p class="muted small">Ο inverter ψαλίδισε ${fmt(e.clipping_hours)} ώρες τον χρόνο. Μέγιστη θερμοκρασία πάνελ
      ${fmt(e.max_cell_temp)} °C. Ωριαία προσομοίωση pvlib με τυπικό έτος καιρού.</p>`;
}
