// Help bubbles: resting the mouse on an element that has an entry in helptexts.js (or reaching it
// with the keyboard) shows a short bubble; «Περισσότερα…» (or F1) opens a bigger box with what it
// does, why it is useful and an example. It finds the elements by event delegation, so it also works
// for buttons other scripts create later, and it never changes the app's state.
(() => {
  const SHOW_DELAY = 1000; // ms the mouse rests on an element before its bubble shows
  const WARM_DELAY = 250; // ms when another bubble was just showing (moving along a row of buttons)
  const FOCUS_DELAY = 500; // ms after the keyboard focuses an element
  const HIDE_GRACE = 400; // ms the bubble stays after the mouse leaves, so it can reach «Περισσότερα…»
  const GAP = 8; // px between the element and the bubble, and from the screen edges

  // Entries without "sel" are found by data-help="<key>" (buttons made by draw.js and others).
  const entries = [];
  for (const [key, e] of Object.entries(window.HELP_TEXTS || {})) {
    const sel = e.sel || `[data-help="${key}"]`;
    try { document.querySelector(sel); } catch { console.warn(`helptexts.js: λάθος επιλογέας στο «${key}»: ${sel}`); continue; }
    entries.push({ key, ...e, sel });
  }
  const ANY = entries.map((e) => e.sel).join(",");

  // ---------- Finding the element under the mouse ----------
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  // "text" picks one of several look-alike elements (e.g. the options of the map menu); it also
  // matches the English translation when the app is shown in English (i18n.js).
  function hasText(el, text) {
    const s = clean(el.textContent);
    return s === text || (typeof window.t === "function" && s === window.t(text));
  }
  function entryFor(el) {
    if (!ANY || !el.matches(ANY)) return null;
    return entries.find((e) => el.matches(e.sel) && (!e.text || hasText(el, e.text))) || null;
  }
  // The nearest element with help, from the node under the mouse upwards. A field's <label> counts
  // as the field, and the bubble is placed by the whole label.
  function findTarget(node) {
    for (let el = node instanceof Element ? node : node?.parentElement; el && el !== document.body; el = el.parentElement) {
      let e = entryFor(el);
      if (e) {
        const label = el.closest("label");
        return { el: label && label.control === el ? label : el, e };
      }
      if (el.tagName === "LABEL" && el.control && (e = entryFor(el.control))) return { el, e };
    }
    return null;
  }

  // ---------- The bubble and the bigger box ----------
  const bubble = document.createElement("div");
  bubble.className = "help-bubble";
  bubble.setAttribute("role", "tooltip");
  bubble.hidden = true;
  bubble.innerHTML = `<p class="help-short"></p><button type="button" class="help-more" tabindex="-1">Περισσότερα…<kbd>F1</kbd></button>`;
  const dialog = document.createElement("dialog");
  dialog.className = "help-dialog";
  dialog.setAttribute("aria-labelledby", "helpDialogTitle");
  dialog.innerHTML = `<div class="help-box">
      <header><h2 id="helpDialogTitle"></h2>
        <button type="button" class="help-close" aria-label="Κλείσιμο"><svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></header>
      <section data-part="what"><h3>Τι κάνει</h3><div></div></section>
      <section data-part="why"><h3>Γιατί είναι χρήσιμο</h3><div></div></section>
      <section data-part="example"><h3>Παράδειγμα</h3><div></div></section>
    </div>`;
  document.body.append(bubble, dialog);

  let hovered = null; // { el, e } under the mouse or keyboard focus
  let shown = null; // { el, e } whose bubble is visible
  let showTimer = 0;
  let hideTimer = 0;
  let lastShown = 0;
  let viaKeyboard = false;

  // The browser's own tooltip (title=) would cover ours: park it in data-help-title while hovering.
  function stashTitles(el) {
    for (const n of [el, ...el.querySelectorAll("[title]")]) {
      if (n.hasAttribute("title")) { n.dataset.helpTitle = n.getAttribute("title"); n.removeAttribute("title"); }
    }
  }
  function restoreTitles(el) {
    for (const n of [el, ...el.querySelectorAll("[data-help-title]")]) {
      if (n.dataset.helpTitle !== undefined) { n.setAttribute("title", n.dataset.helpTitle); delete n.dataset.helpTitle; }
    }
  }
  function setHovered(t) {
    if (hovered) restoreTitles(hovered.el);
    hovered = t;
    if (t) stashTitles(t.el);
  }

  function show(t, keyboard) {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    const r = t.el.getBoundingClientRect();
    if (!t.el.isConnected || (!r.width && !r.height) || dialog.open) return;
    shown = t;
    bubble.querySelector(".help-short").textContent = t.e.short;
    bubble.classList.toggle("keys", !!keyboard);
    bubble.style.left = "0px";
    bubble.style.top = "0px";
    bubble.style.visibility = "hidden";
    bubble.hidden = false;
    place(r, bubble.getBoundingClientRect(), t.e.place);
    bubble.style.visibility = "";
  }
  function hide() {
    clearTimeout(hideTimer);
    if (!shown) return;
    shown = null;
    bubble.hidden = true;
    lastShown = Date.now();
  }
  function scheduleHide() {
    clearTimeout(hideTimer);
    if (shown) hideTimer = setTimeout(hide, HIDE_GRACE);
  }

  // Below the element if it fits, else above, right or left ("place" in an entry goes first);
  // the bubble slides along that side so it always stays on the screen.
  function place(r, b, prefer) {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const clampX = (x) => Math.max(GAP, Math.min(x, vw - GAP - b.width));
    const clampY = (y) => Math.max(GAP, Math.min(y, vh - GAP - b.height));
    const alongX = r.width < b.width ? r.left + (r.width - b.width) / 2 : r.left;
    const alongY = r.top + (r.height - b.height) / 2;
    const spots = {
      bottom: () => [clampX(alongX), r.bottom + GAP],
      top: () => [clampX(alongX), r.top - GAP - b.height],
      right: () => [r.right + GAP, clampY(alongY)],
      left: () => [r.left - GAP - b.width, clampY(alongY)],
    };
    const fits = ([x, y]) => x >= GAP && y >= GAP && x + b.width <= vw - GAP && y + b.height <= vh - GAP;
    let at = null;
    for (const side of [prefer, "bottom", "top", "right", "left"]) {
      if (spots[side] && fits(spots[side]())) { at = spots[side](); break; }
    }
    at = at || [clampX(alongX), clampY(r.bottom + GAP)];
    bubble.style.left = `${Math.round(at[0])}px`;
    bubble.style.top = `${Math.round(at[1])}px`;
  }

  // ---------- Mouse ----------
  document.addEventListener("mouseover", (ev) => {
    if (dialog.open || ev.sourceCapabilities?.firesTouchEvents) return;
    if (bubble.contains(ev.target)) { clearTimeout(hideTimer); clearTimeout(showTimer); setHovered(null); return; }
    const t = findTarget(ev.target);
    if (t && hovered && t.el === hovered.el) return;
    clearTimeout(showTimer);
    setHovered(t);
    if (t && shown && t.el === shown.el) { clearTimeout(hideTimer); return; }
    scheduleHide();
    if (!t) return;
    const warm = shown || Date.now() - lastShown < 600;
    showTimer = setTimeout(() => show(t, false), warm ? WARM_DELAY : SHOW_DELAY);
  });
  document.addEventListener("mouseout", (ev) => {
    if (ev.relatedTarget) return; // left the window
    clearTimeout(showTimer);
    setHovered(null);
    scheduleHide();
  });
  // Clicking means the user is busy with the element: the bubble goes away until the mouse comes back.
  document.addEventListener("pointerdown", (ev) => {
    viaKeyboard = false;
    if (bubble.contains(ev.target)) return;
    clearTimeout(showTimer);
    hide();
  }, true);
  addEventListener("scroll", () => { clearTimeout(showTimer); hide(); }, true);
  addEventListener("resize", hide);
  addEventListener("blur", () => { clearTimeout(showTimer); hide(); });
  bubble.addEventListener("mouseleave", scheduleHide);
  bubble.querySelector(".help-more").addEventListener("click", () => shown && openMore(shown));

  // ---------- Keyboard: focus shows the bubble, F1 opens «Περισσότερα», Esc closes ----------
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Tab" || ev.key.startsWith("Arrow")) viaKeyboard = true;
    if (dialog.open) return;
    if (ev.key === "Escape" && shown) { clearTimeout(showTimer); hide(); return; } // other Esc uses still run
    if (ev.key === "F1") {
      const t = shown || findTarget(document.activeElement);
      if (t) { ev.preventDefault(); openMore(t); }
    }
  });
  document.addEventListener("focusin", (ev) => {
    // Focus coming back from the closed bigger box: its bubble was just read, do not show it again.
    if (!viaKeyboard || dialog.open || dialog.contains(ev.relatedTarget)) return;
    const t = findTarget(ev.target);
    clearTimeout(showTimer);
    if (!t) { if (shown) hide(); return; }
    if (shown && shown.el !== t.el) hide();
    showTimer = setTimeout(() => show(t, true), FOCUS_DELAY);
  });
  document.addEventListener("focusout", () => {
    if (viaKeyboard) { clearTimeout(showTimer); hide(); }
  });

  // ---------- «Περισσότερα»: the bigger box ----------
  dialog.querySelector(".help-close").addEventListener("click", () => dialog.close());
  // A click outside the box (on the dark backdrop) closes it too; Esc is handled by <dialog>.
  dialog.addEventListener("click", (ev) => { if (ev.target === dialog) dialog.close(); });

  // The heading of the box: the entry's "name", else what the element itself says.
  function nameOf(t) {
    if (t.e.name) return t.e.name;
    const el = t.el;
    const said = el.getAttribute("aria-label") || el.dataset.helpTitle || el.getAttribute("title");
    if (said) return clean(said);
    if (el.tagName === "LABEL") {
      const copy = el.cloneNode(true);
      copy.querySelectorAll("input, select, textarea").forEach((n) => n.remove());
      if (clean(copy.textContent)) return clean(copy.textContent);
    }
    const bold = el.querySelector("b, strong");
    return clean(bold ? bold.textContent : el.textContent) || "Βοήθεια";
  }

  function openMore(t) {
    clearTimeout(showTimer);
    hide();
    dialog.querySelector("h2").textContent = nameOf(t);
    for (const part of ["what", "why", "example"]) {
      const box = dialog.querySelector(`[data-part=${part}] div`);
      box.replaceChildren(...String(t.e[part] || "").split("\n").filter(Boolean).map((line) => {
        const p = document.createElement("p");
        p.textContent = line;
        return p;
      }));
    }
    dialog.showModal();
    dialog.querySelector(".help-box").scrollTop = 0;
  }
})();
