// Made-up server for trying the mobile app without the real backend: open /m/?mock=1 (password: demo).
// Only used when ?mock=1 is in the address; the real app never calls it.
window.MOCK_API = async (path, opts = {}) => {
  await new Promise((r) => setTimeout(r, 250));
  const body = opts.json || {};
  const lat = 37.98, lon = 23.72;
  const sq = (dy, dx, h, w) => [[lat + dy, lon + dx], [lat + dy, lon + dx + w], [lat + dy + h, lon + dx + w], [lat + dy + h, lon + dx]];
  const panels = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 8; c++) panels.push(sq(0.00002 + r * 0.000018, 0.00001 + c * 0.00002, 0.000016, 0.000018));
  const projects = [
    { id: "p1", name: "Σπίτι Αθήνα", updated: "2026-10-21T10:00:00", kwp: 13.12, panels: 32, address: "Ερμού 12, Αθήνα", client: "Γ. Παπαδόπουλος" },
    { id: "p2", name: "Αποθήκη Θεσσαλονίκη", updated: "2026-10-18T15:30:00", kwp: 48.4, panels: 118, address: "Βιομηχανική Περιοχή", client: "Alpha ΕΠΕ" },
  ];
  const docs = [
    { kind: "report", title: "Αναφορά", available: true, reason: "" },
    { kind: "plan", title: "Κάτοψη", available: true, reason: "" },
    { kind: "single-line", title: "Μονογραμμικό", available: false, reason: "Λείπει ο σχεδιασμός inverter." },
    { kind: "tech", title: "Τεχνική περιγραφή", available: false, reason: "Λείπει ο σχεδιασμός inverter." },
    { kind: "appendix-i", title: "Παράρτημα Ι", available: false, reason: "Λείπει ο σχεδιασμός inverter." },
  ];
  if (path === "/status") return { enabled: true, needs_password: false };
  if (path === "/login") {
    if (body.password !== "demo") { const e = new Error("Λάθος κωδικός."); e.status = 401; throw e; }
    return { token: "mock-token" };
  }
  if (path === "/logout") return {};
  if (path === "/projects") return projects;
  let m;
  if ((m = /^\/projects\/([^/]+)$/.exec(path))) {
    const p = projects.find((x) => x.id === m[1]);
    if (!p) { const e = new Error("Το έργο δεν βρέθηκε."); e.status = 404; throw e; }
    return { id: p.id, name: p.name, client: p.client, address: p.address, updated: p.updated,
      areas: [sq(0, 0, 0.0001, 0.00018)], keepouts: [sq(0.00004, 0.00012, 0.00002, 0.00002)],
      layout: { panels, count: p.panels, kwp: p.kwp }, settings: {}, report_info: {},
      energy: { annual_kwh: 18400, specific: 1400 }, electrical_ready: false };
  }
  if ((m = /^\/projects\/([^/]+)\/documents$/.exec(path))) return docs;
  if (/^\/projects\/[^/]+\/documents\/[^/?]+/.test(path)) {
    const bytes = new TextEncoder().encode("%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");
    return new Response(new Blob([bytes], { type: "application/pdf" }), { status: 200 });
  }
  throw new Error("mock: " + path);
};
