// Battery (step «Μπαταρία»): which loads to keep when the grid is down, for how many days, and the battery size
// that does it (backend/battery.py, POST /api/battery/autonomy); and what the battery saves from the sun, hour by hour
// (backend/battery_sim.py, POST /api/battery/simulate); the sizes tried with the sun and the finances, and how long the backup
// lasts per month when the sun shines (backend/battery_plan.py, POST /api/battery/proposals and /outage). This file is the
// form, the proposal cards, the savings table and day chart, the sweep chart, the outage table, and what is saved in the
// project. Loaded after app.js and electrical.js
// (uses $, api, state, fmt, toast, withBusy, MONTHS, runLayout, runShading, elec, financeSettings and the finance field finConsumption).
(() => {
  const FIELDS = ["batDays", "batCap", "batPower", "batUsable", "batRound", "batReserve", "batSimul", "batCost", "batFixed", "batSubsidy",
    "batFade", "batReplYear", "batReplPct", "batProfile", "batSeason"];
  const DEFAULTS = {
    batDays: "1", batCap: "", batPower: "", batUsable: "90", batRound: "90", batReserve: "100", batSimul: "70",
    batCost: "800", batFixed: "0", batSubsidy: "0", batFade: "2", batReplYear: "12", batReplPct: "60",
    batProfile: "home", batSeason: "mixed",
  };
  const SET_INFO = {
    basic: "Ψυγείο, καταψύκτης, φωτισμός, router, τηλεόραση και φορτιστές.",
    comfort: "Τα βασικά, και επιπλέον υπολογιστής, αντλία νερού, πλυντήριο, μικροκύματα, ένα κλιματιστικό.",
    house: "Όλη η κατανάλωση του σπιτιού, όπως τη δίνεις στην ετήσια κατανάλωση.",
    custom: "Διάλεξε εσύ ποιες συσκευές μετράνε και με τι ισχύ.",
  };
  const MODES = ["100", "30", "0"]; // reserve % of the «Λειτουργία» choices; anything else is «Δική μου εφεδρεία»
  let presets = null;
  let rows = [];          // [{key, name, kwh_day, peak_w, on, custom}]
  let set = "basic";
  let timer = null;
  let simTimer = null;
  let customId = 0;
  let last = null;        // the last answer of /api/battery/autonomy
  let sim = null;         // the last answer of /api/battery/simulate
  let simChart = null;
  let plan = null;        // the last answer of /api/battery/proposals (the sizes tried with the sun)
  let planKey = "";       // what it was calculated for, without the capacity (the server tries the sizes itself)
  let planTimer = null;
  let planSeq = 0;
  let planChart = null;
  let outage = null;      // the last answer of /api/battery/outage
  let outageTimer = null;
  let outageSeq = 0;

  const enabled = () => $("batOn").checked;
  const num = (id) => ($(id).value === "" ? null : +$(id).value);
  const days = (n) => (Math.round(n * 10) / 10 === 1 ? "ημέρα" : "ημέρες"); // by the number as it is shown
  const eur = (n) => `${fmt(n)} €`;
  const line = (label, value, cls = "") => `<div class="bat-row ${cls}"><span>${label}</span><b>${value}</b></div>`;
  const cmp = (label, a, b, cls = "") => `<div class="bat-cmp ${cls}"><span>${label}</span><b>${a}</b><b>${b}</b></div>`;

  async function loadPresets() {
    if (presets) return presets;
    presets = await api("/api/battery/presets");
    const sel = $("batPreset");
    sel.innerHTML = "";
    sel.add(new Option("Δική μου", ""));
    presets.batteries.forEach((b, i) => sel.add(new Option(b.name, String(i))));
    // Real products of backend/catalog/batteries.json: value "c<index>".
    presets.catalog.forEach((b, i) => sel.add(new Option(b.name, `c${i}`)));
    return presets;
  }

  // A change made by the user: what depends on the battery is out of date. The finance result is dropped, the
  // savings are calculated again when they were on the screen, the autonomy answer follows.
  function changed() {
    if (state.finance) { state.finance = null; if (typeof renderFinance === "function") renderFinance(); }
    syncFinance();
    schedule();
    if (sim) { clearTimeout(simTimer); simTimer = setTimeout(() => calcSim(false), 500); }
    if (outage) { clearTimeout(outageTimer); outageTimer = setTimeout(() => calcOutage(false), 600); }
    if (plan) { clearTimeout(planTimer); planTimer = setTimeout(() => calcPlan(false), 1000); }
  }

  // With a battery the hourly model decides the self-consumption, not the percentage of the finance step.
  function syncFinance() {
    const on = enabled() && num("batCap") > 0;
    $("finBatteryNote").hidden = !on;
    $("finSelf").disabled = on;
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
    changed();
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
    changed();
  }

  document.querySelectorAll("input[name=batSet]").forEach((r) => r.addEventListener("change", () => { if (r.checked && presets) applySet(r.value); }));
  $("batAddLoad").onclick = () => {
    if (set === "house") { set = "custom"; rows = presets.appliances.map((a) => ({ ...a, on: false })); }
    rows.push({ key: `own${++customId}`, name: "Δικό μου φορτίο", kwh_day: 0.5, peak_w: 200, on: true, custom: true });
    applySet("custom");
    renderRows();
  };

  // ---------- Battery model ----------
  const modelOf = (v) => (v === "" ? null : v[0] === "c" ? presets.catalog[+v.slice(1)] : presets.batteries[+v]);
  $("batPreset").addEventListener("change", () => {
    const b = modelOf($("batPreset").value);
    if (!b) return;
    $("batCap").value = b.capacity_kwh;
    $("batPower").value = b.power_kw ?? ""; // a generic size leaves the power automatic
    if (b.usable_kwh) {                     // a real product brings its own usable share and efficiency
      $("batUsable").value = Math.round((b.usable_kwh / b.capacity_kwh) * 1000) / 10;
      if (b.roundtrip_pct) $("batRound").value = b.roundtrip_pct;
    }
    changed();
  });
  const custom = () => { $("batPreset").value = ""; };
  ["batCap", "batPower"].forEach((id) => $(id).addEventListener("input", () => {
    const b = modelOf($("batPreset").value);
    if (b && (num("batCap") !== b.capacity_kwh || num("batPower") !== (b.power_kw ?? null))) custom();
  }));

  // «Λειτουργία» and the reserve percentage are the same setting.
  function syncMode() {
    const v = String(num("batReserve") ?? 100);
    $("batMode").value = MODES.includes(v) ? v : "";
  }
  $("batMode").addEventListener("change", () => {
    if ($("batMode").value === "") { $("batMode").closest("label").nextElementSibling?.setAttribute("open", ""); return; }
    $("batReserve").value = $("batMode").value;
    changed();
  });
  $("batReserve").addEventListener("input", syncMode);

  // The yearly consumption is the same number as the one in the finance step.
  $("batConsumption").addEventListener("input", () => { $("finConsumption").value = $("batConsumption").value; if (set === "house") applySet("house"); });
  $("finConsumption").addEventListener("input", () => { $("batConsumption").value = $("finConsumption").value; if (set === "house" && presets) applySet("house"); });

  // ---------- Autonomy: request and result ----------
  function batteryParams() {
    return {
      capacity_kwh: num("batCap") ?? 0, power_kw: num("batPower"),
      usable_pct: num("batUsable") ?? 90, roundtrip_pct: num("batRound") ?? 90, reserve_pct: num("batReserve") ?? 100,
      cost_per_kwh: num("batCost") ?? 0, cost_fixed: num("batFixed") ?? 0, subsidy_eur: num("batSubsidy") ?? 0,
      fade_pct_per_year: num("batFade") ?? 2, replacement_year: num("batReplYear") ?? 12, replacement_cost_pct: num("batReplPct") ?? 60,
    };
  }
  const loadParams = () => ({ annual_kwh: num("batConsumption"), profile: $("batProfile").value, season: $("batSeason").value });

  const onLoads = () => rows.filter((r) => r.on).map((r) => ({ kwh_day: r.kwh_day, peak_w: r.peak_w }));

  function request() {
    return {
      loads: onLoads(),
      simultaneity_pct: num("batSimul") ?? 70,
      target_days: num("batDays") || 1,
      kwp: state.layout ? state.layout.kwp : null,
      battery: batteryParams(),
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
      html += outageHtml(b);
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
    if (use) use.onclick = () => { $("batCap").value = r.needed_capacity_kwh; custom(); changed(); };
    const outBtn = $("btnBatOutage");
    if (outBtn) outBtn.onclick = () => withBusy(outBtn, () => calcOutage(true));

    const shown = cardList();
    $("batCards").innerHTML = shown.map(cardHtml).join("");
    $("batCards").querySelectorAll(".opt-card").forEach((el) => (el.onclick = () => {
      $("batCap").value = shown[+el.dataset.i].capacity_kwh;
      custom();
      changed();
    }));
  }
  const reserveDays = (c) => ((num("batReserve") ?? 100) > 0 ? c.days_guaranteed : c.days_full) ?? 0;

  // ---------- Proposal cards ----------
  // The ready-made sizes of the autonomy step, with the ones tried with the sun and the finances when they were calculated
  // (they replace the rule of 1 kWh per kWp).
  function cardList() {
    const own = last.cards;
    const tried = plan && plan.savings && plan.cards.length ? plan.cards : own.filter((c) => c.kind === "per_kwp");
    return [...own.filter((c) => c.kind === "days"), ...tried, ...own.filter((c) => c.kind === "manual")];
  }

  const CARD = {
    days: ["Εφεδρεία", "Κρατά τα φορτία που διάλεξες, χωρίς ήλιο"],
    per_kwp: ["Για το βράδυ", "1 kWh ανά kWp πάνελ, για καθημερινή χρήση"],
    manual: ["Χειροκίνητα", "Οι ρυθμίσεις του βήματος όπως είναι"],
    eco: ["Οικονομική", "Το μεγαλύτερο καθαρό κέρδος στη ζωή του συστήματος"],
    eco_no: ["Δεν συμφέρει οικονομικά", "Καμία μπαταρία δεν αποσβένεται· αυτή χάνει το λιγότερο"],
    night: ["Για το βράδυ", "Καλύπτει τη μέση κατανάλωση των ωρών χωρίς ήλιο"],
    autarky: ["Μέγιστη αυτάρκεια", "Η μικρότερη που φτάνει το 90 % της μέγιστης αύξησης κάλυψης"],
  };

  function cardHtml(c, i) {
    const [title, plain] = CARD[c.kind];
    const note = c.above_sweep ? "Δεν φτάνει ούτε το μεγαλύτερο μέγεθος που δοκιμάστηκε" : plain; // «Για το βράδυ» with a large reserve
    const d = c.kind === "days" ? c.days : reserveDays(c);
    let body = '<span class="opt-angles">–</span>';
    if (c.capacity_kwh > 0) {
      body = `<span class="opt-angles"><em>${fmt(d, 1)}</em> ${days(d)}</span>
        <span class="opt-num"><em>${fmt(c.capacity_kwh, 1)}</em> kWh · <em>${fmt(c.power_kw, 1)}</em> kW</span>
        <span class="opt-num"><em>${fmt(c.investment)}</em> €</span>`;
      if (c.npv_gain != null) { // a size tried with the sun and the finances
        body += `<span class="opt-num small">Ιδιοκατανάλωση <em>${fmt(c.self_consumption_pct, 1)}</em> %</span>
          <span class="opt-num small">Κάλυψη κατανάλωσης <em>${fmt(c.autarky_pct, 1)}</em> %</span>
          <span class="opt-num small">${c.payback_years == null ? "δεν αποσβένεται" : `Απόσβεση <em>${fmt(c.payback_years, 1)}</em> έτη`}</span>`;
        if (c.kind === "eco" || c.kind === "eco_no") {
          body += `<span class="opt-num small ${c.npv_gain < 0 ? "bad" : ""}">Κέρδος (NPV) <em>${fmt(c.npv_gain)}</em> €</span>`;
        }
      }
    }
    return `<button type="button" class="opt-card ${c.kind === "eco_no" ? "bad" : ""}" data-i="${i}" ${c.capacity_kwh > 0 ? "" : "disabled"}>
      <b>${title}</b>
      <span class="opt-note">${note}</span>
      ${body}
    </button>`;
  }

  // ---------- Sizes tried with the sun (sweep) ----------
  async function planBody() {
    return {
      simulation: await elec.simulationBody(), load: loadParams(), battery: batteryParams(), finance: financeSettings(),
      loads: onLoads(), simultaneity_pct: num("batSimul") ?? 70, target_days: num("batDays") || 1,
    };
  }

  // manual: the button; otherwise it follows a change while the result is on the screen (errors stay quiet). The sizes do
  // not depend on the capacity typed in the field, so a click on a card does not calculate again.
  async function calcPlan(manual) {
    try {
      await ensureSystem();
      const body = await planBody();
      const key = JSON.stringify({ ...body, battery: { ...body.battery, capacity_kwh: 0 } });
      if (!manual && plan && key === planKey) return;
      const mine = ++planSeq;
      const answer = await api("/api/battery/proposals", "POST", body);
      if (mine !== planSeq) return; // a newer calculation was started meanwhile
      plan = answer;
      planKey = key;
      renderPlan();
      if (last) render();
    } catch (e) { if (manual) throw e; }
  }
  $("btnBatPlan").onclick = () => withBusy($("btnBatPlan"), () => calcPlan(true));

  function renderPlan() {
    $("batPlan").hidden = !plan;
    if (!plan) { drawPlan(); return; }
    const info = [];
    if (!plan.savings) {
      info.push("Η μπαταρία είναι ρυθμισμένη μόνο για εφεδρεία, οπότε δεν κάνει εξοικονόμηση και δεν υπάρχουν οικονομικές προτάσεις. Άλλαξε τη «Λειτουργία» για να βρεις το καλύτερο μέγεθος.");
    } else {
      if (plan.assumed_consumption) info.push("Η κατανάλωση είναι υπόθεση (ίση με την παραγωγή). Βάλε την πραγματική ετήσια κατανάλωση για πιο σωστό αποτέλεσμα.");
      if (plan.cards.some((c) => c.kind === "eco_no")) info.push("Με τις τιμές που έβαλες καμία μπαταρία δεν αποσβένεται στη ζωή του συστήματος· έχει νόημα μόνο για εφεδρεία. Δες το κόστος της μπαταρίας και τον τρόπο σύνδεσης.");
      if ($("finScheme").value === "net_metering") info.push("Με ενεργειακό συμψηφισμό το δίκτυο λειτουργεί ήδη σαν μπαταρία, γι' αυτό η μπαταρία αξίζει συνήθως λιγότερο.");
    }
    if (plan.warning) info.push(plan.warning);
    $("batPlanInfo").replaceChildren(...info.map((t) => Object.assign(document.createElement("span"), { textContent: t })));
    $("batPlan").querySelector(".chart-box").hidden = !plan.savings;
    drawPlan();
  }

  // The gain of every size tried (bars) and how much of the consumption it covers (line).
  function drawPlan() {
    if (planChart) { planChart.destroy(); planChart = null; }
    if (!plan || !plan.savings || !plan.sweep.length || !$("battery").classList.contains("active")) return;
    const rows = plan.sweep;
    planChart = new Chart($("batPlanChart"), {
      data: {
        labels: rows.map((r) => fmt(r.capacity_kwh, 1)),
        datasets: [
          { type: "bar", label: "Κέρδος (NPV) από τη μπαταρία", data: rows.map((r) => r.npv_gain), backgroundColor: rows.map((r) => (r.npv_gain >= 0 ? "#16a34a" : "#ef4444")) },
          { type: "line", label: "Κάλυψη της κατανάλωσης", data: rows.map((r) => r.autarky_pct), borderColor: "#818cf8", pointRadius: 0, tension: 0.25, yAxisID: "y2" },
        ],
      },
      options: {
        plugins: { legend: { labels: { boxWidth: 12 } } },
        scales: {
          x: { title: { display: true, text: "Χωρητικότητα (kWh)" }, ticks: { maxTicksLimit: 14 } },
          y: { title: { display: true, text: "€" } },
          y2: { position: "right", min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: "%" } },
        },
      },
    });
  }

  // ---------- Outage with sun ----------
  // How long the loads keep running per month when the grid goes down but the sun shines (the answer of /api/battery/outage).
  async function calcOutage(manual) {
    try {
      if (!manual && (!(num("batCap") > 0) || !onLoads().length)) return;
      await ensureSystem();
      const mine = ++outageSeq;
      const answer = await api("/api/battery/outage", "POST",
        { simulation: await elec.simulationBody(), load: loadParams(), battery: batteryParams(), loads: onLoads() });
      if (mine !== outageSeq) return;
      outage = answer;
      if (last) render();
    } catch (e) { if (manual) throw e; }
  }

  function outageHtml(b) {
    if (!outage) return '<button type="button" id="btnBatOutage" class="secondary small">Και με ήλιο; Δες ανά μήνα</button>';
    const cap = outage.max_days;
    const long = (v) => v >= cap - 0.05;
    const val = (v, partial) => (long(v) ? `${cap}+` : `${partial ? "≥ " : ""}${fmt(v, 1)}`); // partial: some starts reached the limit, so the average is at least this
    let html = '<div class="bat-outage"><h4>Αν πέσει το δίκτυο και υπάρχει ήλιος</h4>';
    html += long(outage.min_days)
      ? `<p class="bat-ok ok">✓ Κρατά πάνω από <em>${cap}</em> ημέρες σε όλους τους μήνες</p>`
      : line("Χειρότερη περίπτωση", `<span>${MONTHS[outage.worst_month - 1]}</span> · ${fmt(outage.min_days, 1)} <span>${days(outage.min_days)}</span>`);
    html += cmp("Μήνας", "Ελάχιστο, ημέρες", "Μέσο, ημέρες", "bat-cmp-head");
    html += outage.months.map((m) => cmp(MONTHS[m.month - 1], val(m.min_days), val(m.mean_days, m.full_pct > 0),
      m.month === outage.worst_month && !long(outage.min_days) ? "worst" : "")).join("");
    html += `<p class="muted small">Δοκιμάζεται κάθε ώρα του έτους ως αρχή της διακοπής, με τα φορτία που διάλεξες και τον ήλιο του τυπικού έτους.
      Η μπαταρία ξεκινά στο επίπεδο που εγγυάται η εφεδρεία. Το «+» σημαίνει πάνω από 30 ημέρες (πρακτικά χωρίς τέλος).</p>`;
    if (outage.start_kwh <= 0) html += '<p class="muted small">Με εφεδρεία 0 % η μπαταρία μπορεί να είναι άδεια όταν πέσει το δίκτυο· για εγγυημένη αυτονομία άλλαξε τη «Λειτουργία».</p>';
    html += '<p class="muted small">Υποθέτει inverter που δουλεύει και χωρίς δίκτυο. Μεγαλύτερη συννεφιά από του τυπικού έτους μπορεί να κρατήσει λιγότερο.</p>';
    if (!b.power_ok) html += '<p class="muted small">Η ισχύς της μπαταρίας δεν αρκεί για τα φορτία, οπότε στην πράξη θα κρατήσει λιγότερο από τον πίνακα.</p>';
    return `${html}</div>`;
  }

  // ---------- Savings from the sun (hour by hour) ----------
  async function ensureSystem() {
    if (!state.layout || !state.layout.count) await runLayout();
    if (!state.layout || !state.layout.count) throw new Error("Κάνε πρώτα τοποθέτηση πάνελ στο βήμα «Πάνελ».");
    if (!state.shading) await runShading();
  }

  // manual: the button; otherwise it follows a change while the result is on the screen (errors stay quiet).
  async function calcSim(manual) {
    try {
      await ensureSystem();
      const body = await elec.simulationBody();
      sim = await api("/api/battery/simulate", "POST", { simulation: body, load: loadParams(), battery: batteryParams() });
      renderSim();
    } catch (e) { if (manual) throw e; }
  }
  $("btnBatSim").onclick = () => withBusy($("btnBatSim"), () => calcSim(true));

  MONTHS.forEach((m, i) => $("batMonth").add(new Option(m, String(i + 1))));
  $("batMonth").value = "7";
  $("batMonth").addEventListener("change", drawDay);

  function renderSim() {
    $("batSim").hidden = !sim;
    if (!sim) { drawDay(); return; }
    const pct = (v) => `${fmt(v, 1)} %`;
    const kwh = (v) => `${fmt(v)} kWh`;
    const w = sim.without, x = sim.with;
    let html = line("Παραγωγή πάνελ τον χρόνο", kwh(sim.production_kwh)) + line("Κατανάλωση τον χρόνο", kwh(sim.load_kwh));
    html += cmp("", "Χωρίς μπαταρία", "Με μπαταρία", "bat-cmp-head");
    html += cmp("Ιδιοκατανάλωση της παραγωγής", pct(w.self_consumption_pct), pct(x.self_consumption_pct));
    html += cmp("Κάλυψη της κατανάλωσης", pct(w.autarky_pct), pct(x.autarky_pct));
    html += cmp("Αγορά από το δίκτυο", kwh(w.import_kwh), kwh(x.import_kwh));
    html += cmp("Πώληση στο δίκτυο", kwh(w.export_kwh), kwh(x.export_kwh));
    html += cmp("Κύκλοι μπαταρίας τον χρόνο", "–", fmt(x.cycles));
    $("batSimTable").innerHTML = html;
    const info = [];
    if (sim.assumed_consumption) info.push("Η κατανάλωση είναι υπόθεση (ίση με την παραγωγή). Βάλε την πραγματική ετήσια κατανάλωση για πιο σωστό αποτέλεσμα.");
    if ((num("batReserve") ?? 100) >= 100) info.push("Η μπαταρία είναι ρυθμισμένη μόνο για εφεδρεία, οπότε δεν κάνει εξοικονόμηση. Άλλαξε τη «Λειτουργία» για να δεις το όφελος.");
    $("batSimInfo").textContent = info.join(" ");
    if (sim.warning) $("batSimInfo").textContent += `${info.length ? " " : ""}${sim.warning}`;
    drawDay();
  }

  // The average day of the chosen month: production, consumption, what the battery takes and gives, and its level.
  function drawDay() {
    if (simChart) { simChart.destroy(); simChart = null; }
    if (!sim || !$("battery").classList.contains("active")) return;
    const d = sim.day_profiles[$("batMonth").value];
    simChart = new Chart($("batChart"), {
      data: {
        labels: [...Array(24).keys()].map((h) => `${h}:00`),
        datasets: [
          { type: "bar", label: "Φόρτιση μπαταρίας (kW)", data: d.charge, backgroundColor: "#16a34a", stack: "in" },
          { type: "bar", label: "Εκφόρτιση μπαταρίας (kW)", data: d.discharge, backgroundColor: "#ef4444", stack: "out" },
          { type: "line", label: "Παραγωγή (kW)", data: d.pv, borderColor: "#f59e0b", pointRadius: 0, tension: 0.3 },
          { type: "line", label: "Κατανάλωση (kW)", data: d.load, borderColor: "#9ca3af", pointRadius: 0, tension: 0.3 },
          { type: "line", label: "Στάθμη μπαταρίας (%)", data: d.soc_pct, borderColor: "#818cf8", borderDash: [5, 4], pointRadius: 0, tension: 0.2, yAxisID: "y2" },
        ],
      },
      options: {
        plugins: { legend: { labels: { boxWidth: 12 } } },
        scales: {
          x: { title: { display: true, text: "Ώρα της ημέρας" }, ticks: { maxTicksLimit: 12 } },
          y: { title: { display: true, text: "kW" }, beginAtZero: true },
          y2: { position: "right", min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: "%" } },
        },
      },
    });
  }

  // ---------- On / off ----------
  async function show() {
    $("batBody").hidden = !enabled();
    if (!enabled()) { state.battery = null; last = null; sim = null; plan = null; outage = null; renderSim(); renderPlan(); changed(); return; }
    await loadPresets();
    if (!rows.length) applySet(set);
    changed();
  }
  $("batOn").addEventListener("change", () => show().catch((e) => toast(e.message, 6000)));
  FIELDS.forEach((id) => $(id).addEventListener("input", changed));
  // The kWp of the panels may have changed since this step was last open: calculate again when it opens.
  new MutationObserver(() => {
    if (!$("battery").classList.contains("active")) return;
    schedule();
    if (sim) drawDay();
    if (plan) { drawPlan(); calcPlan(false); }
    if (outage) calcOutage(false);
  }).observe($("battery"), { attributes: true, attributeFilter: ["class"] });

  // ---------- Project ----------
  function resetFields() {
    FIELDS.forEach((id) => { $(id).value = DEFAULTS[id]; });
    $("batPreset").value = "";
    $("batOn").checked = false;
    set = "basic";
    rows = [];
    last = null;
    sim = null;
    plan = null;
    planKey = "";
    outage = null;
    state.battery = null;
    $("batBody").hidden = true;
    $("batResult").innerHTML = "";
    $("batCards").innerHTML = "";
    $("batSim").hidden = true;
    $("batPlan").hidden = true;
    if (simChart) { simChart.destroy(); simChart = null; }
    if (planChart) { planChart.destroy(); planChart = null; }
    syncMode();
    syncFinance();
  }

  window.battery = {
    reset() { resetFields(); },

    collect() {
      if (!enabled()) return { enabled: false };
      const inputs = {};
      FIELDS.forEach((id) => (inputs[id] = $(id).value));
      return { enabled: true, set, rows, inputs, result: last, dispatch: sim, plan, outage };
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
      sim = saved.dispatch || null;
      plan = saved.plan || null;
      outage = saved.outage || null;
      customId = rows.length;
      document.querySelectorAll("input[name=batSet]").forEach((r) => { r.checked = r.value === set; });
      $("batSetInfo").textContent = SET_INFO[set];
      state.battery = last ? { inputs: saved.inputs, result: last } : null;
      syncMode();
      syncFinance();
      drawRows();
      render();
      renderSim();
      renderPlan();
      loadPresets().then(schedule).catch(() => {});
    },

    // What the finance step sends along: the system, the consumption and the battery (null without a battery).
    async financeBlock() {
      if (!enabled() || !(num("batCap") > 0)) return null;
      return { simulation: await elec.simulationBody(), load: loadParams(), battery: batteryParams() };
    },

    // The battery's own numbers under the financial results.
    renderFinance(f) {
      const b = f && f.battery;
      $("finBattery").hidden = !b;
      if (!b) return;
      const years = (v) => (v == null ? "δεν αποσβένεται" : `${fmt(v, 1)} έτη`);
      let html = line("Κόστος μπαταρίας", eur(b.capex));
      if (b.investment !== b.capex) html += line("Μετά την επιδότηση", eur(b.investment));
      html += line("Όφελος της μπαταρίας τον 1ο χρόνο", eur(b.first_year_gain)) +
        line("Απόσβεση της μπαταρίας", years(b.payback_years)) +
        line("Κέρδος (NPV) από τη μπαταρία", eur(b.npv_gain)) +
        line("Ιδιοκατανάλωση χωρίς → με μπαταρία", `${fmt(b.self_consumption_without_pct, 1)} % → ${fmt(b.self_consumption_with_pct, 1)} %`) +
        line("Κάλυψη κατανάλωσης χωρίς → με μπαταρία", `${fmt(b.autarky_without_pct, 1)} % → ${fmt(b.autarky_with_pct, 1)} %`);
      $("finBattery").innerHTML = html;
    },
  };
})();
