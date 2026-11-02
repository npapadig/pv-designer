// Existing PV system (project type "existing_pv"): the customer already has panels and wants a battery. No drawing on the map: the system
// is described in the step «Υπάρχον σύστημα» (place, kWp, tilt, azimuth, inverter, the real yearly production). From it this file makes the
// pieces the battery and finance steps need (state.layout / state.shading / state.energy and the body of the hourly simulation, scaled to
// the real yearly production: backend SimulationRequest.target_annual_kwh). Loaded after battery.js; used by app.js, electrical.js and home.js.
(() => {
  const FIELDS = ["exAddress", "exKwp", "exPanels", "exTilt", "exAzimuth", "exAc", "exProd"];
  const DEFAULTS = { exAddress: "", exKwp: "", exPanels: "", exTilt: "30", exAzimuth: "180", exAc: "", exProd: "" };
  const HIDDEN_STEPS = ["secSite", "secShading", "secPanels", "electrical", "secEnergy"]; // the drawing and design steps
  const KWH_PER_KWP = 1400;  // only to fill the finance step when the real production is not given
  const DC_ROUNDTRIP = 94;   // % for a battery on the DC side (a manufacturer claim, 92-96); the AC side keeps the default of the battery step
  let place = null;          // {lat, lon, label}
  let on = false;

  const num = (id) => ($(id).value === "" ? null : +$(id).value);
  const coupling = () => document.querySelector("input[name=exCoupling]:checked")?.value || "ac";
  const active = () => on;

  function setMode(v) {
    on = v;
    document.body.classList.toggle("existing-pv", on);
    const links = [...document.querySelectorAll("#rail a")];
    links.forEach((a) => { a.hidden = on ? HIDDEN_STEPS.includes(a.dataset.step) : a.dataset.step === "secExisting"; });
    links.filter((a) => !a.hidden).forEach((a, i) => { a.querySelector("i").textContent = String(i + 1); });
    window.refreshSteps?.();
  }

  // Where the place is: the search of the map step finds it (a pin on the map is shown) and tells us with "pv:found".
  document.addEventListener("pv:found", (e) => {
    if (!on) return;
    place = { lat: e.detail.lat, lon: e.detail.lng, label: $("exAddress").value };
    $("exPlace").textContent = `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}`;
    apply();
  });
  const find = () => { $("searchBox").value = $("exAddress").value; $("btnSearch").click(); };
  $("btnExSearch").onclick = find;
  $("exAddress").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); find(); } });

  function missing() {
    if (!place) return "Βρες πρώτα την τοποθεσία (διεύθυνση ή συντεταγμένες).";
    if (!(num("exKwp") > 0)) return "Γράψε την ισχύ των πάνελ (kWp).";
    return "";
  }

  // The state the other steps read. Without place or kWp the steps have nothing to work with and say so when asked.
  function apply() {
    const kwp = num("exKwp");
    if (!on || missing()) { state.layout = null; state.energy = null; state.shading = null; return false; }
    const panels = num("exPanels") || Math.max(1, Math.round((kwp * 1000) / 400));
    const prod = num("exProd");
    state.layout = { existing: true, count: panels, kwp, center: [place.lat, place.lon], area_m2: 0 };
    state.shading = { monthly_loss_pct: Array(12).fill(0) }; // the real production already has the shading in it
    state.energy = { annual_kwh: prod || Math.round(kwp * KWH_PER_KWP), specific_yield: prod ? Math.round(prod / kwp) : KWH_PER_KWP, existing: true, estimated: !prod };
    if (!$("projectAddress").value) $("projectAddress").value = place.label || "";
    $("exNote").textContent = prod
      ? `Η προσομοίωση προσαρμόζεται ώστε να βγάζει τις ${Math.round(prod).toLocaleString("el-GR")} kWh που έδωσες· κρατά το σχήμα των ωρών και των εποχών.`
      : "Αν δεν ξέρεις την ετήσια παραγωγή, η εφαρμογή θα υποθέσει τυπική παραγωγή για την περιοχή (λιγότερο ακριβές). Αν έχεις τον αριθμό, γράψ' τον.";
    return true;
  }

  async function simulationBody() {
    const err = missing();
    if (err) throw new Error(err);
    const kwp = num("exKwp");
    return {
      lat: place.lat, lon: place.lon, tilt_deg: num("exTilt") ?? 30, azimuth_deg: num("exAzimuth") ?? 180, mounting: "rack",
      dc_kwp: kwp, ac_kw: num("exAc") || Math.round((kwp / 1.2) * 10) / 10, target_annual_kwh: num("exProd") || null,
    };
  }

  function couplingInfo() {
    $("exCouplingInfo").textContent = coupling() === "dc"
      ? "DC: ο υβριδικός inverter φορτίζει την μπαταρία πριν μετατραπεί το ρεύμα, με λίγο καλύτερη απόδοση (περίπου 92-96 %, ισχυρισμός κατασκευαστών). Συνήθως χρειάζεται νέος υβριδικός inverter: βάλε το κόστος του στα κόστη της μπαταρίας."
      : "AC: η μπαταρία συνδέεται δίπλα στον υπάρχοντα inverter και δουλεύει με σχεδόν κάθε σύστημα (περίπου 85-90 %). Είναι η συνηθισμένη λύση για υπάρχον σύστημα.";
  }
  document.querySelectorAll("input[name=exCoupling]").forEach((r) => r.addEventListener("change", () => {
    if (r.checked && r.value === "dc") $("batRound").value = DC_ROUNDTRIP;
    else if (r.checked) $("batRound").value = "90";
    $("batRound").dispatchEvent(new Event("input", { bubbles: true }));
    couplingInfo();
  }));
  $("exHybrid").addEventListener("change", () => {
    if ($("exHybrid").checked && coupling() !== "dc") document.querySelector("input[name=exCoupling][value=dc]").click();
  });
  FIELDS.filter((id) => id !== "exAddress").forEach((id) => $(id).addEventListener("input", () => { apply(); }));

  $("btnExNext").onclick = () => {
    const err = missing();
    if (err) return toast(err, 5000);
    apply();
    document.querySelector('#rail a[data-step="battery"]').click();
    $("batOn").checked || $("batOn").click();
  };

  function resetFields() {
    FIELDS.forEach((id) => { $(id).value = DEFAULTS[id]; });
    $("exHybrid").checked = false;
    document.querySelector("input[name=exCoupling][value=ac]").checked = true;
    $("exPlace").textContent = "";
    place = null;
    couplingInfo();
  }

  window.existingPv = {
    active,
    simulationBody,

    // A new project of this kind: the prices of the system itself are not part of the study (only the battery is bought).
    begin() {
      resetFields();
      setMode(true);
      $("finCapex").value = 0; $("finSubsidy").value = 0; $("finOm").value = 0; $("finInvYear").value = 0;
      apply();
    },

    reset() { resetFields(); setMode(false); apply(); },

    collect() {
      if (!on) return null;
      const out = { place, coupling: coupling(), hybrid: $("exHybrid").checked };
      FIELDS.forEach((id) => (out[id] = $(id).value));
      return out;
    },

    load(saved) {
      resetFields();
      setMode(state.projectType === "existing_pv");
      if (!on || !saved) return;
      FIELDS.forEach((id) => { if (saved[id] != null) $(id).value = saved[id]; });
      $("exHybrid").checked = !!saved.hybrid;
      const r = document.querySelector(`input[name=exCoupling][value=${saved.coupling || "ac"}]`);
      if (r) r.checked = true;
      place = saved.place || null;
      $("exPlace").textContent = place ? `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}` : "";
      couplingInfo();
      apply();
      if (place) map.setView([place.lat, place.lon], 18);
    },
  };
  couplingInfo();
})();
