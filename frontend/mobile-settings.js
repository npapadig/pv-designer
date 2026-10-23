// "Mobile" panel on the start screen: turns the phone app on/off, sets its password and shows the address with a
// QR code. Talks to GET /api/m/info and POST /api/m/setup (both only from this computer). Texts are translated
// by i18n.js like the rest of the page. QR code: vendor/qr/qr.js.
(() => {
  const btn = document.getElementById("homeMobile");
  if (!btn) return;
  let dlg = null;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  async function call(path, opts) {
    const res = await fetch(path, opts);
    if (res.status === 404) throw new Error("Η λειτουργία «Κινητό» δεν είναι διαθέσιμη σε αυτή την έκδοση.");
    if (!res.ok) {
      let d = "";
      try { d = (await res.json()).detail; } catch {}
      throw new Error(typeof d === "string" && d ? d : "Κάτι πήγε στραβά (" + res.status + ").");
    }
    return res.json();
  }

  function build() {
    dlg = el("div");
    dlg.id = "mobileDlg";
    dlg.hidden = true;
    dlg.setAttribute("role", "dialog");
    dlg.setAttribute("aria-label", "Κινητό");
    dlg.addEventListener("click", (ev) => { if (ev.target === dlg) close(); });
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !dlg.hidden) close(); });
    document.body.append(dlg);
  }
  const close = () => { dlg.hidden = true; };

  async function open() {
    if (!dlg) build();
    dlg.hidden = false;
    show(null, null, "Φόρτωση…");
    try { show(await call("/api/m/info")); }
    catch (e) { show(null, e.message); }
  }

  // info: {enabled, urls, password_set}; error / note: a text on top; restart: the server must be restarted
  function show(info, error, note, restart) {
    const box = el("div", "box");
    box.append(el("h2", null, "Κινητό"));
    box.append(el("p", "muted small", "Δες τα έργα σου στο κινητό (μόνο ανάγνωση): χάρτης και έγγραφα PDF. Το κινητό πρέπει να είναι στο ίδιο Wi-Fi με τον υπολογιστή."));
    if (error) box.append(el("div", "msg err", error));
    if (note) box.append(el("div", "msg", note));
    if (restart) box.append(el("div", "msg warn", "Κλείσε και άνοιξε ξανά την εφαρμογή για να ισχύσει η αλλαγή."));
    const actions = el("div", "actions");
    const closeBtn = el("button", "secondary", "Κλείσιμο");
    closeBtn.type = "button";
    closeBtn.onclick = close;
    if (info) {
      const sw = el("label", "sw");
      const on = el("input");
      on.type = "checkbox";
      on.checked = !!info.enabled;
      sw.append(on, el("span", null, "Ενεργοποίηση για κινητό"));
      const pw = el("input");
      pw.type = "password";
      pw.autocomplete = "new-password";
      pw.placeholder = info.password_set ? "Νέος κωδικός (κενό = ο ίδιος)" : "Κωδικός για το κινητό";
      pw.setAttribute("aria-label", "Κωδικός για το κινητό");
      const field = el("div", "field");
      field.append(el("span", "muted small", info.password_set ? "Έχει οριστεί κωδικός." : "Δεν έχει οριστεί κωδικός ακόμα."), pw);
      const msg = el("div");
      const save = el("button", null, "Αποθήκευση");
      save.type = "button";
      save.onclick = async () => {
        msg.replaceChildren();
        const body = { enabled: on.checked };
        if (pw.value) body.password = pw.value;
        if (on.checked && !info.password_set && !pw.value) { msg.append(el("div", "msg err", "Βάλε πρώτα έναν κωδικό.")); return; }
        save.disabled = true;
        try {
          const r = await call("/api/m/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
          show(await call("/api/m/info"), null, "Αποθηκεύτηκε.", !!(r && r.restart_needed));
        } catch (e) { msg.append(el("div", "msg err", e.message)); save.disabled = false; }
      };
      box.append(sw, field, msg);
      if (info.enabled && info.urls && info.urls.length) {
        const q = el("div", "qr");
        const holder = el("div");
        try { holder.innerHTML = window.QR.svg(info.urls[0], 220); } catch { holder.textContent = ""; }
        q.append(holder, el("span", "muted small", "Σκάναρε με την κάμερα του κινητού ή γράψε τη διεύθυνση:"));
        for (const u of info.urls) {
          const a = el("a", null, u);
          a.href = u; a.target = "_blank"; a.rel = "noopener"; a.translate = false;
          q.append(a);
        }
        q.append(el("span", "muted small", "Μετά πάτα «Προσθήκη στην αρχική οθόνη» στον browser του κινητού."));
        box.append(q);
      } else if (info.enabled) {
        box.append(el("div", "msg warn", "Δεν βρέθηκε διεύθυνση δικτύου. Έλεγξε ότι ο υπολογιστής είναι συνδεδεμένος στο Wi-Fi."));
      }
      actions.append(closeBtn, save);
    } else {
      actions.append(closeBtn);
    }
    box.append(actions);
    dlg.replaceChildren(box);
  }

  btn.addEventListener("click", open);
})();
