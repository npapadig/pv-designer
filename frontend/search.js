// Address suggestions while typing, from Photon (free, OpenStreetMap data): Nominatim does not allow
// search-as-you-type, so it stays only behind the search button (app.js «Search»). Arrows choose,
// Enter or a click goes there, Escape closes. Uses app.js globals ($, map, showFound).
(() => {
  const PHOTON = "https://photon.komoot.io/api/"; // lang=default: local names (Greek in Greece)
  const MIN_CHARS = 3, WAIT_MS = 350, LIMIT = 6;
  const box = $("searchBox"), list = $("searchList");
  let items = [], active = -1, timer = null, ticket = 0, lastQ = "";

  // "Ερμού 10" + "Αθήνα" from the parts Photon returns. An address comes first, a shop or other
  // name at that address after it; `place` tells apart equal names in different towns.
  function describe(p) {
    const address = p.street && p.housenumber ? `${p.street} ${p.housenumber}` : "";
    const main = address || p.name || p.street || p.city || "";
    const place = [p.city || p.locality || p.district || p.county || p.state, p.countrycode !== "GR" && p.country]
      .filter((x) => x && x !== main).join(", ");
    const named = address && p.name && p.name !== p.street ? p.name : "";
    return { main, place, rest: [named, place].filter(Boolean).join(", ") };
  }

  async function suggest(q) {
    const my = ++ticket;
    // Places near the map come first; zoom 8 keeps that preference mild (about a region), so a town
    // elsewhere in Greece still beats a street of the same name nearby.
    const c = map.getCenter();
    const url = `${PHOTON}?${new URLSearchParams({ q, limit: LIMIT, lat: c.lat.toFixed(4), lon: c.lng.toFixed(4), zoom: 8, lang: "default" })}`;
    try {
      const d = await (await fetch(url)).json();
      if (my !== ticket) return;
      const seen = new Set();
      items = (d.features || []).map((f) => ({
        ...describe(f.properties || {}),
        at: L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]),
      })).filter((it) => {
        const key = `${it.main}|${it.place}`; // the same address once
        if (!it.main || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      lastQ = q;
      render();
    } catch {
      if (my === ticket) close(); // no internet: the search button gives its own message
    }
  }

  function render() {
    list.replaceChildren(...items.map((it, i) => {
      const li = document.createElement("li");
      li.id = `searchOpt${i}`;
      li.setAttribute("role", "option");
      const b = document.createElement("b");
      b.textContent = it.main;
      li.append(b);
      if (it.rest) {
        const s = document.createElement("span");
        s.textContent = it.rest;
        li.append(s);
      }
      li.addEventListener("mousedown", (e) => e.preventDefault()); // keep the typing box focused
      li.addEventListener("click", () => pick(i));
      return li;
    }));
    open(items.length > 0);
  }

  function open(on) {
    list.hidden = !on;
    box.setAttribute("aria-expanded", on);
    active = -1;
    highlight();
  }
  function close() { open(false); }

  function highlight() {
    [...list.children].forEach((li, i) => li.classList.toggle("active", i === active));
    if (active >= 0) {
      box.setAttribute("aria-activedescendant", `searchOpt${active}`);
      list.children[active].scrollIntoView({ block: "nearest" });
    } else box.removeAttribute("aria-activedescendant");
  }

  function pick(i) {
    const it = items[i];
    const text = [it.main, it.place].filter(Boolean).join(", ");
    box.value = text;
    clearTimeout(timer);
    ticket++; // a late answer must not reopen the list
    close();
    showFound(it.at, text);
  }

  box.addEventListener("input", () => {
    clearTimeout(timer);
    const q = box.value.trim();
    if (q.length < MIN_CHARS) {
      ticket++;
      close();
      return;
    }
    timer = setTimeout(() => suggest(q), WAIT_MS);
  });

  // Captured on the document, so it runs before app.js's Enter (= Nominatim search).
  document.addEventListener("keydown", (e) => {
    if (e.target !== box || list.hidden) return;
    const n = items.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = e.key === "ArrowDown" ? (active + 1) % n : (active <= 0 ? n - 1 : active - 1);
      highlight();
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(Math.max(active, 0));
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }, true);

  box.addEventListener("blur", close);
  box.addEventListener("focus", () => { if (items.length && box.value.trim() === lastQ) open(true); });
  $("btnSearch").addEventListener("click", () => { clearTimeout(timer); ticket++; close(); });
})();
