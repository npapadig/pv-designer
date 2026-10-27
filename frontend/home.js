// Start screen: new project and the saved projects as cards. Shown when the app opens and from
// the logo on the rail. Uses app.js globals (api, state, loadProject, resetProject, ...).
(() => {
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const icon = (id) => {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("class", "ic");
    s.innerHTML = `<use href="#${id}"/>`;
    return s;
  };
  const when = (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleString("el-GR", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  // Leaving work that was never saved: ask first.
  function okToLeave() {
    return !hasUnsavedWork() ||
      confirm(`Το έργο «${$("projectName").value}» έχει αλλαγές που δεν αποθηκεύτηκαν. Να συνεχίσω χωρίς αποθήκευση;`);
  }

  function goStep(id) {
    const a = document.querySelector(`#rail a[data-step="${id}"]`);
    if (a && !a.classList.contains("active")) a.click();
  }

  let shown = false; // no fade-in when the app opens, so the map does not flash through
  function hide() { $("home").hidden = true; }

  // "Νέο έργο" first asks rooftop or park, then the project name (and the optional engineer); "Πίσω" goes one back.
  function screen(name) {
    $("homeStart").hidden = name !== "start";
    $("homeChoose").hidden = name !== "choose";
    $("homeDetails").hidden = name !== "details";
    $("homeBack").hidden = name !== "choose"; // «Πίσω» sits in the top-left corner of the screen
    $("homeRoofBack").hidden = name !== "details";
    hero(name === "details" ? (kind === "park" ? "park" : "town") : "overview"); // the scene stays on the chosen place
  }
  // The 3D start scene (hero.js) flies to the part of the planet that fits the choice: town or solar park.
  const hero = (where, soft) => window.heroScene && window.heroScene.focus(where, soft);

  async function show() {
    screen("start");
    const open = !!state.projectId || areas.getLayers().length > 0;
    $("homeContinue").hidden = !open;
    $("homeContinueName").textContent = $("projectName").value;
    $("home").classList.toggle("again", shown);
    shown = true;
    $("home").hidden = false;
    $("home").scrollTop = 0;
    await renderProjects();
  }

  async function renderProjects() {
    const box = $("homeProjects");
    let list;
    try { list = await api("/api/projects"); } catch { list = []; }
    box.replaceChildren();
    $("homeEmpty").hidden = list.length > 0;
    for (const p of list) {
      const card = el("div", "proj");
      const open = el("button", "proj-open");
      open.type = "button";
      open.append(el("b", null, p.name || "Χωρίς όνομα"));
      if (p.address) open.append(el("span", "where", p.address));
      open.append(el("span", "when", when(p.updated_at)));
      const tags = el("span", "tags");
      if (p.kwp) tags.append(el("span", "tag kwp", `${fmt(p.kwp, 2)} kWp`));
      if (p.annual_kwh) tags.append(el("span", "tag", `${fmt(p.annual_kwh)} kWh/έτος`));
      if (p.has_plan) tags.append(el("span", "tag", "κάτοψη"));
      if (tags.childElementCount) open.append(tags);
      open.onclick = () => openProject(p.id);
      const del = el("button", "icon-btn ghost danger proj-del");
      del.type = "button";
      del.title = "Διαγραφή";
      del.setAttribute("aria-label", "Διαγραφή");
      del.append(icon("i-trash"));
      del.onclick = () => deleteProject(p);
      card.append(open, del);
      box.append(card);
    }
  }

  async function openProject(id) {
    if (id !== state.projectId && !okToLeave()) return;
    try {
      if (id !== state.projectId) loadProject(await api(`/api/projects/${id}`));
      await refreshProjectList();
      hide();
    } catch (e) { toast(e.message); }
  }

  async function deleteProject(p) {
    if (!confirm(`Να διαγραφεί οριστικά το έργο «${p.name}»;`)) return;
    try {
      await api(`/api/projects/${p.id}`, "DELETE");
      if (p.id === state.projectId) resetProject();
      await refreshProjectList();
      await show();
      toast("Το έργο διαγράφηκε.");
    } catch (e) { toast(e.message); }
  }

  function newProject(asked = false) {
    if (!asked && !okToLeave()) return false;
    resetProject();
    $("projectList").value = "";
    return true;
  }

  // A new project of the chosen kind and roof (saved with it as project_type and roof_type),
  // opened at the "Χώρος" step. faces.js also picks the mounting: racks when flat, flush when pitched.
  function begin(type, roof) {
    if (!newProject()) return false;
    state.projectType = type;
    if (window.faces) faces.setRoof(roof);
    markSaved();
    hide();
    goStep("secSite");
    return true;
  }

  // The choice is only rooftop or park; existing/new building and the roof type are decided on the next screen.
  let kind = null;
  const ENGINEER_KEY = "pv-designer.engineer";
  function askDetails(k) {
    kind = k;
    hero(k === "park" ? "park" : "town");
    $("homeName").value = "Νέο έργο";
    try { $("homeEngineer").value = localStorage.getItem(ENGINEER_KEY) || ""; } catch {}
    screen("details");
    $("homeName").focus();
    $("homeName").select();
  }
  $("homeRooftop").onclick = () => askDetails("rooftop");
  $("homePark").onclick = () => askDetails("park");

  $("homeDetailsForm").onsubmit = (e) => {
    e.preventDefault();
    const name = $("homeName").value.trim() || "Νέο έργο";
    const engineer = $("homeEngineer").value.trim();
    if (!(kind === "park" ? begin("park", "flat") : begin("existing", "pitched"))) return;
    $("projectName").value = name;
    $("engineerName").value = engineer;
    try { localStorage.setItem(ENGINEER_KEY, engineer); } catch {}
    markSaved();
    $("searchBox").focus();
    if (kind === "park") toast("Βρες το χωράφι και σχεδίασε το περίγραμμά του με το εργαλείο πολυγώνου. Στο βήμα «Πάνελ» θα βρεις έτοιμες προτάσεις διάταξης σε βάσεις.", 8000);
  };

  // Pointer (or keyboard focus) resting on a choice: the scene already looks at the town or at the park.
  [["homeRooftop", "town"], ["homePark", "park"]].forEach(([id, where]) => {
    const back = () => { if (!$("homeChoose").hidden) hero("overview", true); };
    for (const ev of ["pointerenter", "focus"]) $(id).addEventListener(ev, () => hero(where, true));
    for (const ev of ["pointerleave", "blur"]) $(id).addEventListener(ev, back);
  });
  $("homeNew").onclick = () => screen("choose");
  $("homeBack").onclick = () => screen("start");
  $("homeRoofBack").onclick = () => screen("choose");
  $("homeContinue").onclick = hide;
  $("btnHome").onclick = show;
  $("btnHomeSheet").onclick = show;
  $("homeTheme").onclick = () => $("btnTheme").click();
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || $("home").hidden) return;
    if (!$("homeDetails").hidden) screen("choose");
    else if (!$("homeChoose").hidden) screen("start");
    else if (!$("homeContinue").hidden) hide();
  });
  // Where the simulation data comes from (PVGIS, weather)
  const srcBox = $("homeSourcesBox");
  $("homeSources").onclick = () => { srcBox.hidden = false; };
  $("homeSourcesClose").onclick = () => { srcBox.hidden = true; };
  srcBox.addEventListener("click", (e) => { if (e.target === srcBox) srcBox.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !srcBox.hidden) { srcBox.hidden = true; e.stopImmediatePropagation(); } }, true);
  api("/api/version").then((v) => { $("homeVersion").textContent = `v${v.version}`; }).catch(() => {});

  window.home = { show, hide };
  show();

  // The app stops by itself when its browser is closed (backend/lifecycle.py): this page says hello,
  // pings every 30 s and says bye when it goes away; a reload says hello again.
  const pageId = window.crypto?.randomUUID?.() || String(Math.random()).slice(2);
  const tellServer = (what) => fetch(`/api/lifecycle/${what}?page=${pageId}`, { method: "POST", keepalive: true });
  let gone = false;
  const ping = () => tellServer("ping").then((r) => { if (r.ok) gone = false; else throw r; }).catch(() => {
    if (!gone) toast("Η εφαρμογή δεν τρέχει πια. Άνοιξέ τη ξανά με το αρχείο εκκίνησης.", 15000);
    gone = true;
  });
  tellServer("hello").catch(() => {});
  setInterval(ping, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) ping(); });
  addEventListener("pagehide", () => navigator.sendBeacon(`/api/lifecycle/bye?page=${pageId}`));
  addEventListener("pageshow", (e) => { if (e.persisted) tellServer("hello").catch(() => {}); });
})();
