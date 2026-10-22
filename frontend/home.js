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

  // "Νέο έργο" first asks where the panels go; the start cards come back with "Πίσω".
  function choosing(on) {
    $("homeStart").hidden = on;
    $("homeChoose").hidden = !on;
  }

  async function show() {
    choosing(false);
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

  // On an existing building: straight to the map, at the address search.
  $("homeBuilding").onclick = () => {
    if (!newProject()) return;
    hide();
    goStep("secSite");
    $("searchBox").focus();
  };

  // On a floor plan: pick the image first (plan.js), then place it on the map.
  $("homePlan").onclick = () => {
    if (!window.plan) return toast("Η κάτοψη δεν είναι ακόμα διαθέσιμη.");
    if (!okToLeave()) return;
    plan.pickFile(async (file) => {
      newProject(true);
      hide();
      goStep("secSite");
      await plan.start(file);
    });
  };

  $("homeNew").onclick = () => choosing(true);
  $("homeBack").onclick = () => choosing(false);
  $("homeContinue").onclick = hide;
  $("btnHome").onclick = show;
  $("btnHomeSheet").onclick = show;
  $("homeTheme").onclick = () => $("btnTheme").click();
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || $("home").hidden) return;
    if (!$("homeChoose").hidden) choosing(false);
    else if (!$("homeContinue").hidden) hide();
  });
  api("/api/version").then((v) => { $("homeVersion").textContent = `v${v.version}`; }).catch(() => {});

  window.home = { show, hide };
  show();
})();
