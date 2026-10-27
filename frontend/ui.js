// Look and feel: one step at a time in the floating panel, the step rail, the results dock,
// the light/dark theme and chart colours. Loaded last; it only reads app state and never
// changes how the calculations work.
(() => {
  const THEME_KEY = "pv-designer.theme";
  const root = document.documentElement;
  const isLight = () => root.dataset.theme === "light";

  // ---------- Charts ----------
  // app.js picks plain colours; swap them for the theme's palette when a chart is drawn.
  const SUN = ["#ffc53d", "#ff8a3d"];
  function sunGradient(chart) {
    const { ctx, chartArea } = chart;
    if (!chartArea) return SUN[1];
    const g = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
    g.addColorStop(0, SUN[1]);
    g.addColorStop(1, SUN[0]);
    return g;
  }
  const RECOLOR = {
    "#f59e0b": (c) => sunGradient(c),
    "#9ca3af": () => (isLight() ? "rgba(17,24,39,0.18)" : "rgba(255,255,255,0.22)"),
    "#16a34a": () => (isLight() ? "#0d9488" : "#2dd4bf"),
    "#ef4444": () => "#ff4d6d",
  };
  const recolor = (chart, v) => {
    if (Array.isArray(v)) return v.map((x) => (RECOLOR[x] ? RECOLOR[x](chart) : x));
    if (typeof v === "string" && RECOLOR[v]) return (ctx) => RECOLOR[v](ctx.chart || chart);
    return v;
  };
  const themePlugin = {
    id: "pvTheme",
    beforeInit(chart) {
      for (const ds of chart.config.data.datasets) {
        ds.backgroundColor = recolor(chart, ds.backgroundColor);
        ds.borderColor = recolor(chart, ds.borderColor);
        if (ds.type === "line") Object.assign(ds, { borderWidth: 3, fill: false, pointHoverRadius: 5 });
      }
    },
  };

  function styleCharts() {
    if (!window.Chart) return;
    const muted = getComputedStyle(root).getPropertyValue("--muted").trim();
    const grid = isLight() ? "rgba(17,24,39,0.07)" : "rgba(255,255,255,0.07)";
    const d = Chart.defaults;
    d.font.family = getComputedStyle(root).getPropertyValue("--font").trim();
    d.font.size = 11;
    d.color = muted;
    d.borderColor = grid;
    d.maintainAspectRatio = false;
    d.scale.grid.color = grid;
    d.scale.border.display = false;
    d.scale.ticks.color = muted;
    d.elements.bar.borderRadius = 6;
    d.datasets.bar.maxBarThickness = 26;
    d.plugins.legend.labels.usePointStyle = true;
    d.plugins.legend.labels.pointStyle = "circle";
    d.plugins.legend.labels.boxHeight = 7;
    Object.assign(d.plugins.tooltip, {
      backgroundColor: "rgba(13,17,30,0.94)", padding: 10, cornerRadius: 10, boxPadding: 4,
      titleFont: { weight: "700" }, usePointStyle: true,
    });
    Object.values(Chart.instances).forEach((c) => c.update("none"));
  }
  if (window.Chart) Chart.register(themePlugin);

  function setTheme(t) {
    root.dataset.theme = t;
    try { localStorage.setItem(THEME_KEY, t); } catch {}
    styleCharts();
  }
  $("btnTheme").onclick = () => setTheme(isLight() ? "dark" : "light");
  styleCharts();

  // ---------- Steps ----------
  const links = [...document.querySelectorAll("#rail a")];
  const sections = links.map((a) => $(a.dataset.step));
  const body = document.querySelector("#sidebar .panel-body");
  let current = 0;

  function show(i) {
    current = Math.max(0, Math.min(sections.length - 1, i));
    sections.forEach((s, j) => s.classList.toggle("active", j === current));
    links.forEach((a, j) => a.classList.toggle("active", j === current));
    $("stepKicker").textContent = `Βήμα ${current + 1} από ${sections.length}`;
    $("btnPrev").disabled = current === 0;
    $("btnNext").hidden = current === sections.length - 1;
    $("btnNext").classList.remove("nudge");
    links[current].classList.remove("nudge");
    window.setPanelsVisible?.(sections[current].id !== "secShading"); // the shadow step shows shadows, not the layout
    body.scrollTop = 0;
    setCollapsed(false);
    updateHint();
  }
  links.forEach((a, i) => a.addEventListener("click", (e) => {
    e.preventDefault();
    if (i === current && !document.body.classList.contains("collapsed")) setCollapsed(true);
    else show(i);
  }));
  $("btnPrev").onclick = () => show(current - 1);
  $("btnNext").onclick = () => show(current + 1);

  function setCollapsed(on) {
    document.body.classList.toggle("collapsed", on);
    $("btnExpand").hidden = !on;
  }
  $("btnCollapse").onclick = () => setCollapsed(true);
  $("btnExpand").onclick = () => setCollapsed(false);

  // A step is done when its result exists; a step that just finished points to the next one.
  const DONE = {
    secProject: () => !!state.projectId,
    secSite: () => areas.getLayers().length > 0,
    secPanels: () => !!state.layout,
    secShading: () => !!state.shading,
    electrical: () => !!state.electrical,
    secEnergy: () => !!state.energy,
    finance: () => !!state.finance,
  };
  const wasDone = {};
  let hadEnergy = false;
  function tick() {
    links.forEach((a, i) => {
      let done = false;
      try { done = DONE[a.dataset.step](); } catch {}
      a.classList.toggle("done", done);
      if (done && wasDone[i] === false && i === current && i < links.length - 1 && a.dataset.step !== "secProject") {
        links[i + 1].classList.add("nudge");
        $("btnNext").classList.add("nudge");
      }
      wasDone[i] = done;
    });
    const dock = $("results");
    dock.classList.toggle("empty", !state.layout);
    if (state.energy && !hadEnergy) dock.classList.add("open"); // show the analysis the first time
    hadEnergy = !!state.energy;
    updateHint();
  }

  // ---------- Results dock and map hint ----------
  $("btnDock").onclick = () => $("results").classList.toggle("open");

  function updateHint() {
    let noArea = true;
    try { noArea = areas.getLayers().length === 0; } catch {}
    const step = sections[current].id;
    $("mapHint").hidden = !(noArea && (step === "secSite" || step === "secPanels"));
  }

  show(0);
  tick();
  setInterval(tick, 700);
})();
