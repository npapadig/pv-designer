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

  // "Νέο έργο" first asks where the panels go, then (for a building) the roof; "Πίσω" goes one back.
  function screen(name) {
    $("homeStart").hidden = name !== "start";
    $("homeChoose").hidden = name !== "choose";
    $("homeRoof").hidden = name !== "roof";
    $("homeBack").hidden = name !== "choose"; // «Πίσω» sits in the top-left corner of the screen
    $("homeRoofBack").hidden = name !== "roof";
  }

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

  // A building: first the roof question.
  let building = null;
  function askRoof(type) {
    building = type;
    $("homeRoofAsk").textContent = type === "new" ? "Τι στέγη θα έχει το νέο κτίριο;" : "Τι στέγη έχει το κτίριο;";
    screen("roof");
  }
  $("homeBuilding").onclick = () => askRoof("existing");
  $("homeNewBuilding").onclick = () => askRoof("new");

  // An existing building goes straight to the address search; a new one is first placed on the map,
  // then plan.js offers to upload the floor plan.
  function startBuilding(roof) {
    if (!begin(building, roof)) return;
    if (building === "new" && window.plan) plan.askWhere();
    $("searchBox").focus();
  }
  $("homeFlat").onclick = () => startBuilding("flat");
  $("homePitched").onclick = () => startBuilding("pitched");

  // A park on a field: flat ground, panels on racks (the layout proposals of the "Πάνελ" step).
  $("homePark").onclick = () => {
    if (!begin("park", "flat")) return;
    $("searchBox").focus();
    toast("Βρες το χωράφι και σχεδίασε το περίγραμμά του με το εργαλείο πολυγώνου. Στο βήμα «Πάνελ» θα βρεις έτοιμες προτάσεις διάταξης σε βάσεις.", 8000);
  };

  $("homeNew").onclick = () => screen("choose");
  $("homeBack").onclick = () => screen("start");
  $("homeRoofBack").onclick = () => screen("choose");
  $("homeContinue").onclick = hide;
  $("btnHome").onclick = show;
  $("btnHomeSheet").onclick = show;
  $("homeTheme").onclick = () => $("btnTheme").click();
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || $("home").hidden) return;
    if (!$("homeRoof").hidden) screen("choose");
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
