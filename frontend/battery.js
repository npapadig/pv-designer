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
    realStale();
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
    realSync();
    changed();
  }
  $("batOn").addEventListener("change", () => show().catch((e) => toast(e.message, 6000)));
  FIELDS.forEach((id) => $(id).addEventListener("input", changed));
  // The kWp of the panels may have changed since this step was last open: calculate again when it opens.
  new MutationObserver(() => {
    if (!$("battery").classList.contains("active")) return;
    schedule();
    realSync();
    realDraw();
    if (sim) drawDay();
    if (plan) { drawPlan(); calcPlan(false); }
    if (outage) calcOutage(false);
  }).observe($("battery"), { attributes: true, attributeFilter: ["class"] });

  // ---------- With the user's own measurements ----------
  // The consumption of the building from the grid operator's smart meter (and the production from the inverter's program) as files,
  // CSV or Excel. backend/battery_api.py reads them (POST /api/battery/data/parse, /api/battery/data/analyse) and answers whether a
  // battery pays and where. The files live only in this page (they are sent with every request); the project keeps only the summary.
  const real = { cons: [], prod: [], inj: [], result: null, key: "", saved: false, savedPreview: null };
  let realSummary = null;     // what the project keeps (collect() / load())
  let realDay = "year";       // the average day on the chart: year | winter | summer
  const realCharts = {};
  const MAX_FILE_MB = 40;
  const SFX = { cons: "C", prod: "P", inj: "C" };   // the "if it was not read right" choices of a file group (the injection shares the consumption's)
  const existingMode = () => !!(window.existingPv && window.existingPv.active());
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const dateTxt = (iso) => new Date(iso).toLocaleDateString("el-GR");
  const hourTxt = (h) => `${String(h).padStart(2, "0")}:00`;
  const HOURS = [...Array(24).keys()].map((h) => `${h}:00`);
  const kwh = (v) => `${fmt(v)} kWh`;

  const moreHtml = (s) => `<details class="bat-more"><summary class="small">Αν το αρχείο δεν διαβάστηκε σωστά</summary>
    <div class="grid2">
      <label>Μονάδα <select id="brUnit${s}"><option value="">Αυτόματα</option><option value="kwh">kWh</option><option value="wh">Wh</option><option value="kw">kW</option><option value="w">W</option></select></label>
      <label>Η ώρα δείχνει <select id="brLabel${s}"><option value="">Αυτόματα</option><option value="start">Την αρχή της μέτρησης</option><option value="end">Το τέλος της μέτρησης</option></select></label>
    </div></details>`;
  const dropHtml = (s) => `<label class="bat-drop" id="brDrop${s}"><input type="file" id="brFile${s}" accept=".csv,.txt,.tsv,.xlsx,.xls" multiple hidden>
    <b>Διάλεξε αρχείο</b><span>ή σύρε το εδώ</span></label><div id="brList${s}" class="bat-files"></div>`;

  const realBox = document.createElement("details");
  realBox.id = "batReal";
  realBox.className = "bat-real";
  realBox.open = true;
  realBox.innerHTML = `<summary>Με τα δικά σου μετρήματα <span class="bat-tag">πιο ακριβές</span></summary>
    <p class="muted small">Ανέβασε την κατανάλωσή σου από τον έξυπνο μετρητή. Η εφαρμογή βλέπει ώρα με την ώρα (ή ανά 15 λεπτά) πόσο ρεύμα
      καταναλώνεις όταν παράγουν τα πάνελ και λέει αν αξίζει η μπαταρία και πού ακριβώς. Το αρχείο δεν αποθηκεύεται στο έργο, μόνο η περίληψη του αποτελέσματος.</p>
    <h4 class="bat-sub">Κατανάλωση</h4>
    <p class="muted small">Ζήτα από τον ΔΕΔΔΗΕ την καμπύλη κατανάλωσης του έξυπνου μετρητή σου, ανά ώρα ή ανά 15 λεπτά, για όλο το τελευταίο έτος (αρχείο Excel ή CSV).
      Αν έχεις πολλά αρχεία (π.χ. ένα για κάθε εξάμηνο), ανέβασέ τα όλα.</p>
    ${dropHtml("C")}
    <label id="brKindBox" hidden>Τι δείχνει το αρχείο
      <select id="brKind"><option value="meter">Ρεύμα που αγοράζω από το δίκτυο (αρχείο ΔΕΔΔΗΕ)</option>
        <option value="consumption">Συνολική κατανάλωση του κτιρίου</option><option value="">Αυτόματα</option></select>
      <span class="muted small">Αν το σύστημά σου πουλάει ρεύμα στο δίκτυο, ανέβασε και το αρχείο έγχυσης (στην ενότητα «Παραγωγή του φωτοβολταϊκού» παρακάτω).
        Χωρίς αυτό η κατανάλωση βγαίνει μεγαλύτερη από την πραγματική.</span></label>
    ${moreHtml("C")}
    <label class="radio"><input type="checkbox" id="brFill" checked> Αν λείπουν μήνες, συμπλήρωσέ τους με εκτίμηση</label>
    <div id="brPreview" hidden>
      <div id="brPrevFacts" class="bat-table"></div>
      <div class="chart-box"><canvas id="brChartPrevDay" height="190"></canvas></div>
      <div class="chart-box"><canvas id="brChartPrevMonth" height="170"></canvas></div>
    </div>
    <div id="brProdBox" hidden>
      <h4 class="bat-sub">Παραγωγή του φωτοβολταϊκού</h4>
      <label class="radio"><input type="radio" name="brProd" value="forecast" id="brProdForecast" checked> Η πρόβλεψη της εφαρμογής (για τα kWp που έδωσες)</label>
      <label class="radio"><input type="radio" name="brProd" value="file" id="brProdFile"> Αρχείο από το πρόγραμμα του inverter (πιο ακριβές)</label>
      <div id="brProdFileBox" hidden>${dropHtml("P")}${moreHtml("P")}</div>
      <details class="bat-more"><summary class="small">Έχεις χωριστό αρχείο με το ρεύμα που πουλάς στο δίκτυο (έγχυση);</summary>
        <p class="muted small">Ο ΔΕΔΔΗΕ το δίνει συχνά χωριστά. Χωρίς αυτό, η κατανάλωση βγαίνει μεγαλύτερη όταν το σύστημά σου πουλάει ρεύμα.</p>
        ${dropHtml("J")}</details>
    </div>
    <p id="brProdNew" class="muted small">Η παραγωγή είναι η πρόβλεψη της εφαρμογής για τα πάνελ που σχεδίασες.</p>
    <h4 class="bat-sub">Τιμές και λειτουργία</h4>
    <p class="muted small">Βάλε τις τιμές που ισχύουν για σένα (προσφορά μπαταρίας, τιμολόγιο ρεύματος). Τα ίδια πεδία υπάρχουν στα βήματα «Μπαταρία» και «Οικονομική ανάλυση»: όπου τα αλλάξεις, αλλάζουν παντού.</p>
    <div class="grid2">
      <label>Κόστος μπαταρίας (€ ανά kWh) <input id="brCost" type="number" min="0" step="50"></label>
      <label>Τρόπος σύνδεσης <select id="brScheme"></select></label>
      <label>Τιμή ρεύματος (€/kWh) <input id="brRetail" type="number" min="0" step="0.01"></label>
      <label id="brExportLabel">Τιμή πώλησης περίσσειας (€/kWh) <input id="brExport" type="number" min="0" step="0.01"></label>
      <label id="brOffsetLabel" hidden>Αξία συμψηφισμού (€/kWh) <input id="brOffset" type="number" min="0" step="0.01"></label>
    </div>
    <label>Λειτουργία στον υπολογισμό <select id="brMode"></select></label>
    <button id="btnBatReal" class="primary" type="button"><svg class="ic"><use href="#i-zap"/></svg>Υπολογισμός με τα μετρήματά μου</button>
    <p id="brStale" class="bat-banner" hidden>Άλλαξες κάτι μετά τον υπολογισμό. Πάτα ξανά το κουμπί για να ενημερωθεί το αποτέλεσμα.</p>
    <div id="brResult" hidden></div>`;
  $("batBody").prepend(realBox);

  // The same settings as in the steps «Μπαταρία» and «Οικονομική ανάλυση»: both fields show one value.
  const MIRROR = [["brCost", "batCost"], ["brScheme", "finScheme"], ["brRetail", "finRetail"], ["brExport", "finExport"], ["brOffset", "finOffset"]];
  $("brScheme").innerHTML = $("finScheme").innerHTML;
  [["30", "30"], ["0", "0"], ["own", ""]].forEach(([value, from]) => {
    const o = [...$("batMode").options].find((x) => x.value === from);
    if (o) $("brMode").add(new Option(o.text, value));
  });
  MIRROR.forEach(([mine, theirs]) => {
    const push = () => { $(theirs).value = $(mine).value; $(theirs).dispatchEvent(new Event("input", { bubbles: true })); $(theirs).dispatchEvent(new Event("change", { bubbles: true })); realSchemeFields(); };
    $(mine).addEventListener("input", push);
    $(mine).addEventListener("change", push);
    ["input", "change"].forEach((ev) => $(theirs).addEventListener(ev, () => realPull()));
  });
  function realPull() {
    MIRROR.forEach(([mine, theirs]) => { if (document.activeElement !== $(mine)) $(mine).value = $(theirs).value; });
    realSchemeFields();
    realStale();
  }
  function realSchemeFields() {
    $("brExportLabel").hidden = $("brScheme").value !== "net_billing";
    $("brOffsetLabel").hidden = $("brScheme").value !== "net_metering";
  }
  // What the mode starts as: the reserve of the battery step when it saves money, otherwise «Εξοικονόμηση και εφεδρεία».
  function realMode() {
    if ($("brMode").dataset.touched) return;
    const r = num("batReserve") ?? 100;
    $("brMode").value = r === 0 || r === 30 ? String(r) : r > 0 && r < 100 ? "own" : "30";
  }
  $("brMode").addEventListener("change", () => { $("brMode").dataset.touched = "1"; realStale(); });
  const realReserve = () => ($("brMode").value === "own" ? num("batReserve") ?? 30 : +$("brMode").value);

  // What depends on the mode (existing system or a new one) and on the other steps.
  function realSync() {
    const ex = existingMode();
    $("brKindBox").hidden = !ex;
    $("brProdBox").hidden = !ex;
    $("brProdNew").hidden = ex;
    realPull();
    realMode();
  }

  // ---- files ----
  const groupList = (g) => real[g];
  const toB64 = (file) => new Promise((ok, fail) => {
    const fr = new FileReader();
    fr.onload = () => ok(String(fr.result).split(",")[1] || "");
    fr.onerror = () => fail(new Error("Δεν μπόρεσα να διαβάσω το αρχείο."));
    fr.readAsDataURL(file);
  });

  function fileBody(f, g) {
    const s = SFX[g];
    const o = { filename: f.name, content_b64: f.b64, unit: $(`brUnit${s}`).value || null, label: $(`brLabel${s}`).value || null };
    if (g === "cons") o.kind = existingMode() ? $("brKind").value || null : null;
    if (g === "prod") o.kind = "production";
    return o;
  }

  async function addFiles(g, files) {
    for (const file of files) {
      if (file.size > MAX_FILE_MB * 1048576) { toast(`Το αρχείο είναι πολύ μεγάλο (πάνω από ${MAX_FILE_MB} MB).`, 6000); continue; }
      const f = { name: file.name, size: file.size, b64: await toB64(file), busy: true, info: null, error: "" };
      if (g === "inj") real.inj = [f]; else groupList(g).push(f);
      real.saved = false;
      await parseOne(f, g);
    }
  }

  async function parseOne(f, g) {
    f.busy = true; f.error = ""; f.info = null;
    renderFiles(g);
    try { f.info = await api("/api/battery/data/parse", "POST", fileBody(f, g)); } catch (e) { f.error = e.message; }
    f.busy = false;
    renderFiles(g);
    renderPreview();
    realStale();
  }
  const reparse = (g) => Promise.all(groupList(g).map((f) => parseOne(f, g)));

  const LIST_ID = { cons: "brListC", prod: "brListP", inj: "brListJ" };
  function renderFiles(g) {
    const box = $(LIST_ID[g]);
    box.innerHTML = groupList(g).map((f, i) => {
      let body = "";
      if (f.busy) body = '<span class="muted small">Διαβάζω…</span>';
      else if (f.error) body = `<span class="bat-err">${esc(f.error)}</span>`;
      else {
        const p = f.info;
        body = `<span class="muted small">${fmt(p.days, 0)} ημέρες · κάθε ${p.step_minutes} λεπτά · ${dateTxt(p.start)} – ${dateTxt(p.end)}</span>` +
          (p.messages || []).map(msgHtml).join("");
      }
      return `<div class="bat-file"><div><b>${esc(f.name)}</b>${body}</div>
        <button type="button" class="icon-btn ghost" data-i="${i}" aria-label="Διαγραφή" title="Διαγραφή"><svg class="ic"><use href="#i-x"/></svg></button></div>`;
    }).join("");
    box.querySelectorAll("button").forEach((b) => (b.onclick = () => {
      groupList(g).splice(+b.dataset.i, 1);
      real.saved = false;
      renderFiles(g);
      renderPreview();
      realStale();
    }));
  }
  const WARN = ["send_rest_of_year", "partial_period", "export_unknown"];
  const msgHtml = (m) => `<p class="bat-msg ${WARN.includes(m.code) ? "warn" : ""}">${esc(m.text)}</p>`;

  ["C", "P", "J"].forEach((s) => {
    const g = s === "C" ? "cons" : s === "P" ? "prod" : "inj";
    const input = $(`brFile${s}`), drop = $(`brDrop${s}`);
    input.addEventListener("change", () => { const files = [...input.files]; input.value = ""; addFiles(g, files).catch((e) => toast(e.message, 6000)); });
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles(g, [...e.dataTransfer.files]).catch((er) => toast(er.message, 6000)); });
  });
  ["brUnitC", "brLabelC", "brKind"].forEach((id) => $(id).addEventListener("change", () => { reparse("cons"); reparse("inj"); }));
  ["brUnitP", "brLabelP"].forEach((id) => $(id).addEventListener("change", () => reparse("prod")));
  document.querySelectorAll("input[name=brProd]").forEach((r) => r.addEventListener("change", () => { $("brProdFileBox").hidden = !$("brProdFile").checked; realStale(); }));
  $("brFill").addEventListener("change", realStale);

  // ---- what was read ----
  const previewInfo = () => {
    const ok = real.cons.filter((f) => f.info);
    return ok.length ? ok.reduce((a, b) => (b.info.days > a.info.days ? b : a)).info : real.savedPreview;
  };

  function renderPreview() {
    const p = previewInfo();
    $("brPreview").hidden = !p;
    if (!p) { realDraw(); return; }
    $("brPrevFacts").innerHTML =
      line("Περίοδος", `${dateTxt(p.start)} – ${dateTxt(p.end)}`) + line("Ημέρες με μετρήσεις", fmt(p.days, 0)) +
      line("Ανάλυση", `κάθε ${p.step_minutes} λεπτά`) + line("Ενέργεια στο αρχείο", kwh(p.total_kwh)) +
      line("Μέση ενέργεια ανά ημέρα", `${fmt(p.total_kwh / p.days, 1)} kWh`) + line("Μέγιστη ισχύς", `${fmt(p.peak_kw, 1)} kW`) +
      line("Βασική ισχύς (το χαμηλότερο επίπεδο)", `${fmt(p.base_kw, 2)} kW`);
    realDraw();
  }

  // ---- the answer ----
  const VERDICT = { yes: ["Ναι, αξίζει", "ok"], marginal: ["Οριακά", "mid"], no: ["Δεν αξίζει οικονομικά", "bad"], none: ["Δεν βγήκε αποτέλεσμα", "mid"] };
  const VERDICT_TEXT = {
    yes: "Με τις τιμές που έβαλες η μπαταρία αποσβένεται μέσα στη ζωή της και αφήνει κέρδος.",
    marginal: "Βγαίνει μικρό κέρδος ή αργή απόσβεση. Εξαρτάται πολύ από την τιμή της μπαταρίας και του ρεύματος.",
    no: "Με τις τιμές που έβαλες η μπαταρία δεν βγάζει πίσω τα χρήματά της. Αυτό είναι το μέγεθος που χάνει το λιγότερο.",
  };
  const REASONS = {
    net_metering: "Με ενεργειακό συμψηφισμό το δίκτυο λειτουργεί ήδη σαν μπαταρία, γι' αυτό η μπαταρία αξίζει συνήθως λιγότερο.",
    little_surplus: "Περισσεύει πολύ λίγο ρεύμα από τα πάνελ, άρα η μπαταρία έχει λίγα να αποθηκεύσει.",
    already_high_self_use: "Χρησιμοποιείς ήδη σχεδόν όλη την παραγωγή τη στιγμή που γίνεται, άρα η μπαταρία προσθέτει λίγα.",
    small_price_gap: "Η τιμή που αγοράζεις το ρεύμα και η τιμή που το πουλάς διαφέρουν λίγο, άρα το να το κρατάς για αργότερα κερδίζει λίγα.",
  };

  function verdictHtml(r) {
    const v = r.verdict, [title, cls] = VERDICT[v.code];
    let h = `<div class="bat-verdict ${cls}"><b>${title}</b>`;
    if (v.code === "none") {
      h += `<p>${r.savings_possible ? "Δεν υπάρχει παραγωγή για να αποθηκευτεί." : "Η μπαταρία είναι ρυθμισμένη μόνο για εφεδρεία, οπότε δεν κάνει εξοικονόμηση."}</p></div>`;
    } else {
      h += `<p>${VERDICT_TEXT[v.code]}</p></div>`;
      h += line("Μέγεθος μπαταρίας που βγάζει το καλύτερο αποτέλεσμα", `${fmt(v.capacity_kwh, 1)} kWh`) + line("Κόστος μπαταρίας", eur(v.investment)) +
        line("Όφελος τον 1ο χρόνο", eur(v.first_year_gain)) +
        line("Απόσβεση", v.payback_years == null ? "δεν αποσβένεται" : `${fmt(v.payback_years, 1)} έτη`) +
        line("Κέρδος (NPV) από τη μπαταρία", eur(v.npv_gain), v.npv_gain < 0 ? "bad" : "");
    }
    if (v.reasons.length) h += `<ul class="bat-why">${v.reasons.map((k) => `<li>${REASONS[k]}</li>`).join("")}</ul>`;
    return h;
  }

  function coverageHtml(c) {
    if (!c) return "";
    const chips = MONTHS.map((m, i) => `<span class="bat-mchip ${c.month_real_pct[i] >= 50 ? "real" : c.month_real_pct[i] > 0 ? "part" : "est"}">${m}</span>`).join("");
    return `<div class="bat-cover">${line("Πραγματικές μετρήσεις", `${fmt(c.real_pct, 0)} % του έτους`)}
      <div class="bat-chips">${chips}</div>
      <div class="bat-legend"><i class="real"></i>Μετρημένος μήνας <i class="part"></i>Εν μέρει <i class="est"></i>Εκτίμηση</div></div>`;
  }

  function flowHtml(b) {
    const part = (cls, pct) => `<span class="${cls}" style="flex:${Math.max(pct, 0.4)}">${pct >= 12 ? `${fmt(pct, 0)} %` : ""}</span>`;
    const selfPct = b.self_consumption_pct, autPct = b.autarky_pct;
    return `<div class="bat-flowbox"><div class="bat-flowlabel">Παραγωγή πάνελ</div>
      <div class="bat-flow">${part("direct", selfPct)}${part("export", 100 - selfPct)}</div>
      <div class="bat-flowlabel">Κατανάλωση</div>
      <div class="bat-flow">${part("direct", autPct)}${part("grid", 100 - autPct)}</div>
      <div class="bat-legend"><i class="direct"></i>Την ώρα που παράγεται <i class="export"></i>Περισσεύει και πουλιέται <i class="grid"></i>Από το δίκτυο</div></div>` +
      line("Παραγωγή πάνελ τον χρόνο", kwh(b.production_kwh)) + line("Κατανάλωση τον χρόνο", kwh(b.consumption_kwh)) +
      line("Καταναλώνεται την ώρα που παράγεται", kwh(b.direct_kwh)) + line("Ιδιοκατανάλωση της παραγωγής", `${fmt(b.self_consumption_pct, 1)} %`) +
      line("Κάλυψη της κατανάλωσης", `${fmt(b.autarky_pct, 1)} %`);
  }

  // The hours of the day (as ranges) where a series of 24 averages is at least a share of its peak.
  function hourRanges(a, share = 0.3) {
    const mx = Math.max(...a);
    if (!(mx > 0.01)) return [];
    const out = [];
    let start = null;
    for (let h = 0; h <= 24; h++) {
      if (h < 24 && a[h] >= mx * share) { if (start === null) start = h; } else if (start !== null) { out.push(`${hourTxt(start)}–${hourTxt(h)}`); start = null; }
    }
    return out;
  }

  function withHtml(r) {
    const d = r.detail, w = d.with, b = r.base;
    let h = '<h4 class="bat-sub">Με την καλύτερη μπαταρία</h4>' + line("Μέγεθος και ισχύς", `${fmt(d.capacity_kwh, 1)} kWh · ${fmt(d.power_kw, 1)} kW`);
    h += cmp("", "Χωρίς μπαταρία", "Με μπαταρία", "bat-cmp-head") +
      cmp("Ιδιοκατανάλωση της παραγωγής", `${fmt(b.self_consumption_pct, 1)} %`, `${fmt(w.self_consumption_pct, 1)} %`) +
      cmp("Κάλυψη της κατανάλωσης", `${fmt(b.autarky_pct, 1)} %`, `${fmt(w.autarky_pct, 1)} %`) +
      cmp("Αγορά από το δίκτυο", kwh(b.import_kwh), kwh(w.import_kwh)) +
      cmp("Πώληση στο δίκτυο", kwh(b.export_kwh), kwh(w.export_kwh)) +
      cmp("Κύκλοι μπαταρίας τον χρόνο", "–", fmt(w.cycles));
    h += line("Ενέργεια που μετακινεί η μπαταρία τον χρόνο", kwh(w.discharged_kwh)) +
      line("Το πολύ που θα μπορούσε να μετακινηθεί", kwh(d.ceiling_shift_kwh));
    h += '<p class="muted small">Το «πολύ που θα μπορούσε» είναι το μικρότερο από την περίσσεια και την αγορά από το δίκτυο: πέρα από αυτό δεν υπάρχει τι να μετακινηθεί, όσο μεγάλη κι αν είναι η μπαταρία.</p>';
    return h;
  }

  function whereHtml(r) {
    const d = r.detail, months = d.months, prof = d.day_profiles.year;
    const key = (m) => (m.gain_eur == null ? m.shifted : m.gain_eur);
    const top = [...months].sort((a, b) => key(b) - key(a)).slice(0, 3).filter((m) => m.shifted > 0).sort((a, b) => a.month - b.month);
    const charge = hourRanges(prof.charge), emptied = hourRanges(prof.discharge);
    let h = '<h4 class="bat-sub">Πού και πότε αξίζει</h4>';
    if (top.length) h += line("Αξίζει περισσότερο τους μήνες", top.map((m) => MONTHS[m.month - 1]).join(", "));
    if (charge.length) h += line("Φορτίζει κυρίως", charge.join(", "));
    if (emptied.length) h += line("Αδειάζει κυρίως", emptied.join(", "));
    const mx = Math.max(...months.map((m) => m.shifted), 1);
    h += cmp("Μήνας", "Μετακινείται", "Κέρδος", "bat-cmp-head");
    h += months.map((m) => `<div class="bat-month"><span>${MONTHS[m.month - 1]}</span><i style="width:${(m.shifted / mx) * 100}%"></i><b>${kwh(m.shifted)}</b><b>${m.gain_eur == null ? "–" : eur(m.gain_eur)}</b></div>`).join("");
    if (months.some((m) => m.gain_eur == null)) h += '<p class="muted small">Με ενεργειακό συμψηφισμό δεν υπολογίζεται κέρδος ανά μήνα.</p>';
    return h;
  }

  function sweepHtml(r) {
    const best = r.best && r.best.capacity_kwh;
    let h = '<h4 class="bat-sub">Ποιο μέγεθος αξίζει</h4><div class="chart-box"><canvas id="brChartSweep" height="210"></canvas></div>';
    h += `<div class="bat-sweep head"><span>kWh</span><span>Κόστος μπαταρίας</span><span>Κέρδος (NPV)</span><span>Απόσβεση</span></div>`;
    h += r.sweep.map((s) => `<div class="bat-sweep ${s.capacity_kwh === best ? "best" : ""}"><span>${fmt(s.capacity_kwh, 1)}</span><span>${eur(s.investment)}</span>
      <span class="${s.npv_gain < 0 ? "neg" : ""}">${eur(s.npv_gain)}</span><span>${s.payback_years == null ? "–" : `${fmt(s.payback_years, 1)} έτη`}</span></div>`).join("");
    return h;
  }

  function renderReal() {
    const r = real.result, box = $("brResult");
    Object.keys(realCharts).filter((k) => !k.startsWith("prev")).forEach((k) => { realCharts[k].destroy(); delete realCharts[k]; });
    box.hidden = !r;
    if (!r) { realStale(); return; }
    let h = "";
    if (real.saved && realSummary) {
      h += `<p class="bat-banner">Αποθηκευμένο αποτέλεσμα από <b>${dateTxt(realSummary.saved_at)}</b>. Για να το ξαναϋπολογίσεις, ανέβασε ξανά τα αρχεία.</p>`;
    }
    const msgs = [...(r.messages || [])];
    if (r.warning) msgs.push({ code: "warning", text: r.warning });
    // what makes the verdict unreliable comes before it
    h += msgs.filter((m) => m.code === "export_unknown").map((m) => `<p class="bat-banner">${esc(m.text)}</p>`).join("");
    h += verdictHtml(r);
    h += coverageHtml(r.coverage);
    h += msgs.filter((m) => m.code !== "export_unknown").map(msgHtml).join("");
    h += '<h4 class="bat-sub">Πόσο ρεύμα καταναλώνεις ταυτόχρονα με τα πάνελ</h4>' + flowHtml(r.base);
    if (r.detail) {
      h += withHtml(r) + whereHtml(r);
      h += `<h4 class="bat-sub">Μια μέση ημέρα</h4>
        <div class="row segmented">${[["year", "Όλο το έτος"], ["winter", "Χειμώνας"], ["summer", "Καλοκαίρι"]].map(([v, t]) =>
          `<label class="radio"><input type="radio" name="brDay" value="${v}" ${v === realDay ? "checked" : ""}> ${t}</label>`).join("")}</div>
        <div class="chart-box tall"><canvas id="brChartDay" height="260"></canvas></div>
        <h4 class="bat-sub">Μήνας με μήνα</h4><div class="chart-box"><canvas id="brChartMonth" height="200"></canvas></div>`;
      if (r.detail.daily) h += '<h4 class="bat-sub">Όλο το έτος, ημέρα με ημέρα</h4><div class="chart-box"><canvas id="brChartYear" height="200"></canvas></div>';
      h += sweepHtml(r);
    }
    h += '<p class="muted small">Είναι εκτίμηση με βάση τα μετρήματα και τις τιμές που έβαλες, όχι εγγύηση. Αν αλλάξει η κατανάλωσή σου ή οι τιμές του ρεύματος, αλλάζει και το αποτέλεσμα.</p>';
    box.innerHTML = h;
    box.querySelectorAll("input[name=brDay]").forEach((x) => x.addEventListener("change", () => { if (x.checked) { realDay = x.value; drawDayChart(); } }));
    realDraw();
    realStale();
  }

  // ---- charts ----
  function realChart(key, id, config) {
    if (realCharts[key]) { realCharts[key].destroy(); delete realCharts[key]; }
    const canvas = $(id);
    if (canvas && $("battery").classList.contains("active")) realCharts[key] = new Chart(canvas, config);
  }
  const LEGEND = { plugins: { legend: { labels: { boxWidth: 12 } } } };
  const line_ = (label, data, color, extra = {}) => ({ type: "line", label, data, borderColor: color, pointRadius: 0, tension: 0.3, ...extra });

  function drawDayChart() {
    const d = real.result && real.result.detail;
    if (!d) return;
    const p = d.day_profiles[realDay];
    realChart("day", "brChartDay", { data: {
      labels: HOURS,
      datasets: [
        { type: "bar", label: "Φόρτιση μπαταρίας (kW)", data: p.charge, backgroundColor: "#16a34a", stack: "in" },
        { type: "bar", label: "Εκφόρτιση μπαταρίας (kW)", data: p.discharge, backgroundColor: "#ef4444", stack: "out" },
        line_("Παραγωγή (kW)", p.pv, "#f59e0b"), line_("Κατανάλωση (kW)", p.load, "#9ca3af"),
        line_("Αγορά από το δίκτυο με μπαταρία (kW)", p.import_with, "#38bdf8", { borderDash: [4, 3] }),
        line_("Στάθμη μπαταρίας (%)", p.soc_pct, "#818cf8", { borderDash: [5, 4], yAxisID: "y2" }),
      ],
    }, options: { ...LEGEND, scales: {
      x: { title: { display: true, text: "Ώρα της ημέρας" }, ticks: { maxTicksLimit: 12 } },
      y: { title: { display: true, text: "kW" }, beginAtZero: true },
      y2: { position: "right", min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: "%" } },
    } } });
  }

  function realDraw() {
    const p = previewInfo();
    if (p) {
      // a season the file does not reach would be a flat line at zero: leave it out
      const reach = new Set(p.covered_months || []);
      const has = (months) => months.some((m) => reach.has(m));
      const days = [line_("Όλο το έτος", p.avg_day_kw.year, "#818cf8")];
      if (has([12, 1, 2])) days.push(line_("Χειμώνας", p.avg_day_kw.winter, "#38bdf8"));
      if (has([6, 7, 8])) days.push(line_("Καλοκαίρι", p.avg_day_kw.summer, "#f59e0b"));
      realChart("prevDay", "brChartPrevDay", { type: "line", data: { labels: HOURS, datasets: days },
      options: { ...LEGEND, scales: { x: { title: { display: true, text: "Ώρα της ημέρας" }, ticks: { maxTicksLimit: 12 } }, y: { title: { display: true, text: "kW" }, beginAtZero: true } } } });
      const cov = reach;
      realChart("prevMonth", "brChartPrevMonth", { type: "bar", data: { labels: MONTHS, datasets: [
        { label: "Μέση κατανάλωση ανά ημέρα (kWh)", data: p.daily_kwh_avg_by_month.map((v, i) => (cov.has(i + 1) ? v : null)), backgroundColor: "#818cf8" }] },
      options: { ...LEGEND, scales: { y: { title: { display: true, text: "kWh" }, beginAtZero: true } } } });
    }
    const r = real.result, d = r && r.detail;
    if (!d) return;
    drawDayChart();
    const m = d.months;
    realChart("month", "brChartMonth", { data: { labels: MONTHS, datasets: [
      { type: "bar", label: "Κατανάλωση (kWh)", data: m.map((x) => x.load), backgroundColor: "#9ca3af" },
      { type: "bar", label: "Παραγωγή (kWh)", data: m.map((x) => x.pv), backgroundColor: "#f59e0b" },
      line_("Αγορά από το δίκτυο χωρίς μπαταρία (kWh)", m.map((x) => x.import_without), "#ef4444", { borderDash: [4, 3] }),
      line_("Αγορά από το δίκτυο με μπαταρία (kWh)", m.map((x) => x.import_with), "#16a34a"),
    ] }, options: { ...LEGEND, scales: { y: { title: { display: true, text: "kWh" }, beginAtZero: true } } } });
    if (d.daily) {
      realChart("year", "brChartYear", { type: "line", data: { labels: d.daily.date.map((s) => `${s.slice(8)}/${s.slice(5, 7)}`), datasets: [
        line_("Κατανάλωση (kWh την ημέρα)", d.daily.load, "#9ca3af", { borderWidth: 1.2, tension: 0 }),
        line_("Παραγωγή (kWh την ημέρα)", d.daily.pv, "#f59e0b", { borderWidth: 1.2, tension: 0 }),
        line_("Αγορά από το δίκτυο με μπαταρία (kWh την ημέρα)", d.daily.import_with, "#38bdf8", { borderWidth: 1.2, tension: 0 })] },
      options: { ...LEGEND, scales: { x: { ticks: { maxTicksLimit: 12 } }, y: { title: { display: true, text: "kWh" }, beginAtZero: true } } } });
    }
    const rows = r.sweep;
    if (rows && rows.length) {
      realChart("sweep", "brChartSweep", { data: { labels: rows.map((x) => fmt(x.capacity_kwh, 1)), datasets: [
        { type: "bar", label: "Κέρδος (NPV) από τη μπαταρία", data: rows.map((x) => x.npv_gain), backgroundColor: rows.map((x) => (x.npv_gain >= 0 ? "#16a34a" : "#ef4444")) },
        line_("Κάλυψη της κατανάλωσης", rows.map((x) => x.autarky_pct), "#818cf8", { yAxisID: "y2", tension: 0.25 })] },
      options: { ...LEGEND, scales: { x: { title: { display: true, text: "Χωρητικότητα (kWh)" } }, y: { title: { display: true, text: "€" } },
        y2: { position: "right", min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: "%" } } } } });
    }
  }

  // ---- the calculation ----
  // The sizes are tried by the server, with the power that goes with each size; the savings need a reserve below 100 %.
  const realBattery = () => ({ ...batteryParams(), capacity_kwh: 0, power_kw: null, reserve_pct: realReserve() });
  const realKey = () => JSON.stringify([realBattery(), financeSettings(), $("brFill").checked, existingMode(), $("brKind").value, $("brProdFile").checked,
    ["C", "P"].map((s) => [$(`brUnit${s}`).value, $(`brLabel${s}`).value]), ["cons", "prod", "inj"].map((g) => groupList(g).map((f) => [f.name, f.b64.length]))]);
  function realStale() {
    $("brStale").hidden = !(real.result && !real.saved && real.key && real.key !== realKey());
  }

  async function runReal() {
    if (!real.cons.length) throw new Error("Ανέβασε πρώτα το αρχείο της κατανάλωσης.");
    if ([...real.cons, ...real.prod, ...real.inj].some((f) => f.busy)) throw new Error("Περίμενε να διαβαστούν τα αρχεία.");
    if ([...real.cons, ...real.prod, ...real.inj].some((f) => f.error)) throw new Error("Κάποιο αρχείο δεν διαβάστηκε· δες το μήνυμα κάτω από το αρχείο.");
    const ex = existingMode();
    if (ex && $("brProdFile").checked && !real.prod.length) throw new Error("Ανέβασε το αρχείο του inverter ή διάλεξε την πρόβλεψη της εφαρμογής.");
    const useProd = ex && $("brProdFile").checked;
    let simulation = null, kwp = 0;
    try {
      if (!ex) await ensureSystem();
      simulation = await elec.simulationBody();
      kwp = (state.layout && state.layout.kwp) || simulation.dc_kwp || 0;
    } catch (e) { if (!useProd) throw e; }
    const key = realKey();
    const answer = await api("/api/battery/data/analyse", "POST", {
      consumption: fileBody(real.cons[0], "cons"), more_consumption: real.cons.slice(1).map((f) => fileBody(f, "cons")),
      injection: ex && real.inj.length ? fileBody(real.inj[0], "inj") : null,
      production: useProd ? fileBody(real.prod[0], "prod") : null, more_production: useProd ? real.prod.slice(1).map((f) => fileBody(f, "prod")) : [],
      fill_year: $("brFill").checked, simulation, has_pv: ex, kwp,
      battery: realBattery(), finance: financeSettings(),
    });
    real.result = answer;
    real.key = key;
    real.saved = false;
    realSummary = summaryOf(answer);
    renderReal();
    $("brResult").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("btnBatReal").onclick = () => withBusy($("btnBatReal"), runReal);

  // What the project keeps: the answer without the day-by-day consumption, and the plain facts of the files (not the files).
  function summaryOf(answer) {
    const res = JSON.parse(JSON.stringify(answer));
    if (res.detail) delete res.detail.daily;
    const info = (f) => (f.info ? { name: f.name, days: f.info.days, step_minutes: f.info.step_minutes, start: f.info.start, end: f.info.end } : { name: f.name });
    return { saved_at: new Date().toISOString(), has_pv: existingMode(), files: real.cons.map(info), production_files: real.prod.map(info),
      result: res, preview: JSON.parse(JSON.stringify(previewInfo() || null)) };
  }

  function realReset() {
    real.cons = []; real.prod = []; real.inj = []; real.result = null; real.key = ""; real.saved = false; real.savedPreview = null;
    realSummary = null;
    realDay = "year";
    Object.values(realCharts).forEach((c) => c.destroy());
    Object.keys(realCharts).forEach((k) => delete realCharts[k]);
    ["cons", "prod", "inj"].forEach(renderFiles);
    $("brResult").hidden = true; $("brResult").innerHTML = "";
    $("brPreview").hidden = true;
    $("brStale").hidden = true;
    ["brUnitC", "brLabelC", "brUnitP", "brLabelP"].forEach((id) => { $(id).value = ""; });
    $("brFill").checked = true;
    $("brProdForecast").checked = true;
    $("brProdFileBox").hidden = true;
    delete $("brMode").dataset.touched;
  }

  function realLoad(saved) {
    realReset();
    if (!saved || !saved.result) { realSync(); return; }
    realSummary = saved;
    real.result = saved.result;
    real.saved = true;
    real.savedPreview = saved.preview || null;
    realSync();
    renderPreview();
    renderReal();
  }

  // ---------- Project ----------
  function resetFields() {
    realReset();
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
      return { enabled: true, set, rows, inputs, result: last, dispatch: sim, plan, outage, real: realSummary };
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
      realLoad(saved.real);
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
