// Battery (step «Μπαταρία»): which loads to keep when the grid is down, for how many days, and the battery size
// that does it. The calculations are in backend/battery.py (POST /api/battery/autonomy); this file is the form,
// the proposal cards and what is saved in the project. Loaded after app.js and electrical.js
// (uses $, api, state, fmt, toast and the finance field finConsumption).
(() => {
  const FIELDS = ["batDays", "batCap", "batPower", "batUsable", "batRound", "batReserve", "batSimul", "batCost", "batFixed", "batSubsidy"];
  const DEFAULTS = {
    batDays: "1", batCap: "", batPower: "", batUsable: "90", batRound: "90", batReserve: "100", batSimul: "70",
    batCost: "800", batFixed: "0", batSubsidy: "0",
  };
  const SET_INFO = {
    basic: "Ψυγείο, καταψύκτης, φωτισμός, router, τηλεόραση και φορτιστές.",
    comfort: "Τα βασικά, και επιπλέον υπολογιστής, αντλία νερού, πλυντήριο, μικροκύματα, ένα κλιματιστικό.",
    house: "Όλη η κατανάλωση του σπιτιού, όπως τη δίνεις στην ετήσια κατανάλωση.",
    custom: "Διάλεξε εσύ ποιες συσκευές μετράνε και με τι ισχύ.",
  };
  let presets = null;
  let rows = [];          // [{key, name, kwh_day, peak_w, on, custom}]
  let set = "basic";
  let timer = null;
  let customId = 0;
  let last = null;        // the last answer of the server

  const enabled = () => $("batOn").checked;
  const num = (id) => ($(id).value === "" ? null : +$(id).value);
  const days = (n) => (Math.round(n * 10) / 10 === 1 ? "ημέρα" : "ημέρες"); // by the number as it is shown

  async function loadPresets() {
    if (presets) return presets;
    presets = await api("/api/battery/presets");
    const sel = $("batPreset");
    sel.innerHTML = "";
    sel.add(new Option("Δική μου", ""));
    presets.batteries.forEach((b, i) => sel.add(new Option(b.name, String(i))));
    return presets;
  }

  // ---------- Loads ----------
  function applySet(name) {
    set = name;
    document.querySelectorAll("input[name=batSet]").forEach((r) => { r.checked = r.value === name; });
    $("batSetInfo").textContent = SET_INFO[name];
    if (name === "house") {
      const annual = num("batConsumption");
      rows = [{ key: "house", name: "Όλο το σπίτι (μέση κατανάλωση)", on: true,
        kwh_day: annual ? Math.round((annual / 365) * 100) / 100 : presets.house.kwh_day, peak_w: presets.house.peak_w }];
    } else if (name !== "custom") {
      const keep = new Set(presets.sets[name]);
      const old = new Map(rows.filter((r) => !r.custom && r.key !== "house").map((r) => [r.key, r]));
      rows = presets.appliances.map((a) => ({ ...a, ...(old.get(a.key) ? { kwh_day: old.get(a.key).kwh_day, peak_w: old.get(a.key).peak_w } : {}), on: keep.has(a.key) }));
    } else if (!rows.length || rows[0].key === "house") {
      rows = presets.appliances.map((a) => ({ ...a, on: false }));
    }
    renderRows();
  }

  function renderRows() {
    drawRows();
    schedule();
  }

  function drawRows() {
    const box = $("batLoads");
    box.innerHTML = "";
    rows.forEach((r, i) => {
      const row = document.createElement("div");
      row.className = "bat-load" + (r.on ? "" : " off");
      row.innerHTML = `<input type="checkbox" aria-label="Μετράει"><span class="bat-name"></span>
        <label class="bat-num"><input type="number" min="0" step="0.1" aria-label="kWh ανά ημέρα"><span>kWh</span></label>
        <label class="bat-num"><input type="number" min="0" step="50" aria-label="Ισχύς σε watt"><span>W</span></label>
        ${r.custom ? '<button type="button" class="icon-btn ghost bat-del" aria-label="Διαγραφή" title="Διαγραφή"><svg class="ic"><use href="#i-x"/></svg></button>' : ""}`;
      const [chk, kwh, w] = row.querySelectorAll("input");
      chk.checked = r.on;
      kwh.value = r.kwh_day;
      w.value = r.peak_w;
      const nameEl = row.querySelector(".bat-name");
      if (r.custom) {
        nameEl.innerHTML = '<input type="text" maxlength="40" aria-label="Όνομα φορτίου">';
        nameEl.firstChild.value = r.name;
        nameEl.firstChild.oninput = () => { r.name = nameEl.firstChild.value; schedule(); };
      } else {
        nameEl.textContent = r.name;
      }
      chk.onchange = () => { r.on = chk.checked; row.classList.toggle("off", !r.on); fromTable(); };
      kwh.oninput = () => { r.kwh_day = +kwh.value || 0; fromTable(); };
      w.oninput = () => { r.peak_w = +w.value || 0; fromTable(); };
      const del = row.querySelector(".bat-del");
      if (del) del.onclick = () => { rows.splice(i, 1); renderRows(); fromTable(); };
      box.appendChild(row);
    });
  }

  // Changing a tick or a value in the table makes the set «Δικά μου», except for the single whole-house row.
  function fromTable() {
    if (set !== "custom" && set !== "house") {
      set = "custom";
      document.querySelectorAll("input[name=batSet]").forEach((r) => { r.checked = r.value === "custom"; });
      $("batSetInfo").textContent = SET_INFO.custom;
    }
    schedule();
  }

  document.querySelectorAll("input[name=batSet]").forEach((r) => r.addEventListener("change", () => { if (r.checked && presets) applySet(r.value); }));
  $("batAddLoad").onclick = () => {
    if (set === "house") { set = "custom"; rows = presets.appliances.map((a) => ({ ...a, on: false })); }
    rows.push({ key: `own${++customId}`, name: "Δικό μου φορτίο", kwh_day: 0.5, peak_w: 200, on: true, custom: true });
    applySet("custom");
    renderRows();
  };

  // ---------- Battery model ----------
  $("batPreset").addEventListener("change", () => {
    const i = $("batPreset").value;
    if (i === "") return;
    const b = presets.batteries[+i];
    $("batCap").value = b.capacity_kwh;
    $("batPower").value = b.power_kw ?? ""; // a generic size leaves the power automatic
    schedule();
  });
  const custom = () => { $("batPreset").value = ""; };
  ["batCap", "batPower"].forEach((id) => $(id).addEventListener("input", () => {
    const i = $("batPreset").value;
    if (i !== "") {
      const b = presets.batteries[+i];
      if (num("batCap") !== b.capacity_kwh || num("batPower") !== b.power_kw) custom();
    }
  }));

  // The yearly consumption is the same number as the one in the finance step.
  $("batConsumption").addEventListener("input", () => { $("finConsumption").value = $("batConsumption").value; if (set === "house") applySet("house"); });
  $("finConsumption").addEventListener("input", () => { $("batConsumption").value = $("finConsumption").value; if (set === "house" && presets) applySet("house"); });

  // ---------- Request and result ----------
  function request() {
    return {
      loads: rows.filter((r) => r.on).map((r) => ({ kwh_day: r.kwh_day, peak_w: r.peak_w })),
      simultaneity_pct: num("batSimul") ?? 70,
      target_days: num("batDays") || 1,
      kwp: state.layout ? state.layout.kwp : null,
      battery: {
        capacity_kwh: num("batCap") ?? 0, power_kw: num("batPower"),
        usable_pct: num("batUsable") ?? 90, roundtrip_pct: num("batRound") ?? 90, reserve_pct: num("batReserve") ?? 100,
        cost_per_kwh: num("batCost") ?? 0, cost_fixed: num("batFixed") ?? 0, subsidy_eur: num("batSubsidy") ?? 0,
      },
    };
  }

  function schedule() {
    clearTimeout(timer);
    if (!enabled() || !presets) return;
    timer = setTimeout(calc, 250);
  }

  async function calc() {
    try {
      last = await api("/api/battery/autonomy", "POST", request());
      state.battery = { inputs: request(), result: last };
      render();
    } catch (e) { toast(e.message, 6000); }
  }

  const eur = (n) => `${fmt(n)} €`;
  const line = (label, value, cls = "") => `<div class="bat-row ${cls}"><span>${label}</span><b>${value}</b></div>`;

  function render() {
    const r = last;
    $("batResult").innerHTML = "";
    $("batCards").innerHTML = "";
    if (!r) return;
    const b = r.battery;
    const need = r.daily_kwh > 0;
    let html = line("Κατανάλωση φορτίων την ημέρα", `${fmt(r.daily_kwh, 2)} kWh`) +
      line("Ισχύς που χρειάζονται ταυτόχρονα", `${fmt(r.peak_kw, 2)} kW`);
    if (!need) {
      html += '<p class="muted small">Διάλεξε τουλάχιστον ένα φορτίο για να υπολογιστεί η αυτονομία.</p>';
    } else if (b.capacity_kwh <= 0) {
      html += '<p class="muted small">Βάλε χωρητικότητα ή διάλεξε μια πρόταση παρακάτω.</p>';
    } else {
      const reserve = num("batReserve") ?? 100;
      html += line("Χρήσιμη ενέργεια της μπαταρίας", `${fmt(b.usable_kwh, 1)} kWh`);
      html += `<div class="bat-big"><span>Κρατά</span><em>${fmt(reserve > 0 ? b.days_guaranteed : b.days_full, 1)}</em><span>${days(reserve > 0 ? b.days_guaranteed : b.days_full)}</span><span>χωρίς ήλιο</span></div>`;
      if (reserve > 0 && reserve < 100) html += line("Αν είναι γεμάτη", `${fmt(b.days_full, 1)} ημέρες`);
      html += `<p class="bat-ok ${b.capacity_ok ? "ok" : "warn"}">${b.capacity_ok ? "✓ Φτάνει για τον στόχο σου" : "✗ Δεν φτάνει για τον στόχο σου"}</p>`;
      html += `<p class="bat-ok ${b.power_ok ? "ok" : "warn"}">${b.power_ok ? "✓ Η ισχύς αρκεί για τα φορτία" : "✗ Η ισχύς είναι μικρότερη από τα φορτία"}</p>`;
      html += line(b.power_auto ? "Ισχύς μπαταρίας (αυτόματη)" : "Ισχύς μπαταρίας", `${fmt(b.power_kw, 1)} kW`);
      html += line("Κόστος μπαταρίας", eur(b.capex));
      if (b.investment !== b.capex) html += line("Μετά την επιδότηση", eur(b.investment));
    }
    if (need) {
      html += `<p class="bat-need">Για <em>${fmt(r.target_days, 1)}</em> <span>${days(r.target_days)}</span> χρειάζονται <em>${fmt(r.needed_capacity_kwh, 1)}</em> kWh</p>
        <button type="button" id="batUseNeeded" class="secondary small">Βάλε αυτό το μέγεθος</button>`;
    }
    $("batResult").innerHTML = html;
    const use = $("batUseNeeded");
    if (use) use.onclick = () => { $("batCap").value = r.needed_capacity_kwh; custom(); schedule(); };

    const CARD = {
      days: ["Εφεδρεία", "Κρατά τα φορτία που διάλεξες, χωρίς ήλιο"],
      per_kwp: ["Για το βράδυ", "1 kWh ανά kWp πάνελ, για καθημερινή χρήση"],
      manual: ["Χειροκίνητα", "Οι ρυθμίσεις του βήματος όπως είναι"],
    };
    $("batCards").innerHTML = r.cards.map((c, i) => {
      const [title, note] = CARD[c.kind];
      const d = reserveDays(c);
      return `<button type="button" class="opt-card" data-i="${i}" ${c.capacity_kwh > 0 ? "" : "disabled"}>
        <b>${title}</b>
        <span class="opt-note">${note}</span>
        ${c.capacity_kwh > 0 ? `<span class="opt-angles"><em>${fmt(c.kind === "days" ? c.days : d, 1)}</em> ${days(c.kind === "days" ? c.days : d)}</span>
        <span class="opt-num"><em>${fmt(c.capacity_kwh, 1)}</em> kWh · <em>${fmt(c.power_kw, 1)}</em> kW</span>
        <span class="opt-num"><em>${fmt(c.investment)}</em> €</span>` : '<span class="opt-angles">–</span>'}
      </button>`;
    }).join("");
    $("batCards").querySelectorAll(".opt-card").forEach((el) => (el.onclick = () => {
      const c = last.cards[+el.dataset.i];
      $("batCap").value = c.capacity_kwh;
      custom();
      schedule();
    }));
  }
  const reserveDays = (c) => ((num("batReserve") ?? 100) > 0 ? c.days_guaranteed : c.days_full) ?? 0;

  // ---------- On / off ----------
  async function show() {
    $("batBody").hidden = !enabled();
    if (!enabled()) { state.battery = null; last = null; return; }
    await loadPresets();
    if (!rows.length) applySet(set);
    schedule();
  }
  $("batOn").addEventListener("change", () => show().catch((e) => toast(e.message, 6000)));
  FIELDS.forEach((id) => $(id).addEventListener("input", schedule));
  // The kWp of the panels may have changed since this step was last open: calculate again when it opens.
  new MutationObserver(() => { if ($("battery").classList.contains("active")) schedule(); })
    .observe($("battery"), { attributes: true, attributeFilter: ["class"] });

  // ---------- Project ----------
  function resetFields() {
    FIELDS.forEach((id) => { $(id).value = DEFAULTS[id]; });
    $("batPreset").value = "";
    $("batOn").checked = false;
    set = "basic";
    rows = [];
    last = null;
    state.battery = null;
    $("batBody").hidden = true;
    $("batResult").innerHTML = "";
    $("batCards").innerHTML = "";
  }

  window.battery = {
    reset() { resetFields(); },

    collect() {
      if (!enabled()) return { enabled: false };
      const inputs = {};
      FIELDS.forEach((id) => (inputs[id] = $(id).value));
      return { enabled: true, set, rows, inputs, result: last };
    },

    // Everything is restored at once (the project's "unsaved changes" check compares right after); the
    // list of battery models and a fresh calculation follow when the server answers.
    load(saved) {
      resetFields();
      $("batConsumption").value = $("finConsumption").value;
      if (!saved || !saved.enabled) return;
      Object.entries(saved.inputs || {}).forEach(([id, v]) => { if ($(id) && v != null) $(id).value = v; });
      $("batOn").checked = true;
      $("batBody").hidden = false;
      set = saved.set || "basic";
      rows = saved.rows || [];
      last = saved.result || null;
      customId = rows.length;
      document.querySelectorAll("input[name=batSet]").forEach((r) => { r.checked = r.value === set; });
      $("batSetInfo").textContent = SET_INFO[set];
      state.battery = last ? { inputs: saved.inputs, result: last } : null;
      drawRows();
      render();
      loadPresets().then(schedule).catch(() => {});
    },
  };
})();
