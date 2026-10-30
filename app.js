// Ma Bibliothèque : gestion de collection BD / livres / JDR, 100 % dans le navigateur.
// Données : localStorage (collection + cache des couvertures). Bases : Google Books, Open Library.

const KEY = "gestio.collection";
const COVERS_KEY = "gestio.covers";
const GENRES = [
  { id: "Fantasy", icon: "i-sword" },
  { id: "SF", icon: "i-planet" },
  { id: "Comics", icon: "i-burst" },
  { id: "Autres BD", icon: "i-book" },
  { id: "Hors BD", icon: "i-d20" },
];
const genreIcon = (g) => (GENRES.find((x) => x.id === g) || GENRES[3]).icon;

// ---------- stockage ----------
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { toast("Impossible d'enregistrer : la mémoire du navigateur est pleine ou bloquée."); return false; }
}
let db = load(KEY, { version: 1, series: [] });
let covers = load(COVERS_KEY, {});
const META_KEY = "gestio.meta";
let meta = load(META_KEY, { changes: 0, lastExport: null });
const persist = () => { save(KEY, db); meta.changes++; save(META_KEY, meta); renderAll(); };
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

// ---------- outils texte ----------
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, " ").trim();
const STOP = new Set(["le", "la", "les", "l", "de", "du", "des", "d", "et", "un", "une", "the", "of", "a"]);
const tokens = (s) => norm(s).split(" ").filter((t) => t && !STOP.has(t));
function bigrams(s) { const n = " " + norm(s) + " "; const out = []; for (let i = 0; i < n.length - 1; i++) out.push(n.slice(i, i + 2)); return out; }
function similarity(a, b) {
  const A = bigrams(a), B = bigrams(b); if (!A.length || !B.length) return 0;
  const m = new Map(); A.forEach((x) => m.set(x, (m.get(x) || 0) + 1));
  let hit = 0; B.forEach((x) => { const c = m.get(x); if (c) { hit++; m.set(x, c - 1); } });
  const dice = (2 * hit) / (A.length + B.length);
  const ta = tokens(a), tb = new Set(tokens(b));
  const cover = ta.length ? ta.filter((t) => tb.has(t)).length / ta.length : 0;
  return Math.max(dice, cover * 0.95);
}
const NUM_WORDS = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16, vingt: 20, vingts: 20, trente: 30, quarante: 40,
  cinquante: 50, soixante: 60, cent: 100, cents: 100 };
const TENS = new Set([20, 30, 40, 50, 60]);
const KEYWORDS = new Set(["tome", "tomes", "t", "n", "no", "numero", "numeros", "num", "volume", "volumes", "vol", "livre", "livres"]);
const LINKS = new Set(["et", "a", "au", "&"]);
// Un mot (ou « quatre-vingt-un ») est-il un nombre écrit en lettres ou en chiffres ?
const isNumTok = (t) => /^\d{1,4}$/.test(t) || t.split("-").every((p) => p in NUM_WORDS || p === "et");
// « tome vingt et un », « 3 et 4 », « tomes 1 à 4 » -> [21], [3, 4], [1, 2, 3, 4]
function readNumbers(toks) {
  const out = []; let cur = null, range = false;
  const push = () => {
    if (cur == null) return;
    if (range && out.length) { const a = out[out.length - 1]; for (let i = a + 1; i <= cur && i - a < 200; i++) out.push(i); }
    else out.push(cur);
    cur = null; range = false;
  };
  const parts = toks.flatMap((t) => (/^\d+$/.test(t) ? [t] : t.split("-")));
  parts.forEach((p, i) => {
    if (/^\d+$/.test(p)) { push(); cur = Number(p); return; }
    if (p === "et" || p === "&") {
      if (cur != null && TENS.has(cur % 100) && /^(un|une|onze)$/.test(parts[i + 1] || "")) return; // vingt et un
      push(); return;
    }
    if (p === "a" || p === "au") { push(); range = true; return; }
    const v = NUM_WORDS[p];
    if (v === 100) cur = (cur || 1) * 100;
    else if (v === 20 && cur != null && cur % 100 === 4) cur += 76; // quatre-vingt
    else cur = (cur || 0) + v;
  });
  push();
  return out;
}
// « Elfes tome 19 » -> { name: "Elfes", num: 19, nums: [19] }
function parseLine(line) {
  const s = line.trim().replace(/[.,;]+$/, "");
  if (!s) return null;
  const raw = s.split(/\s+/);
  const low = raw.map((w) => norm(w.replace(/°/g, "")).replace(/ /g, "-"));
  if (raw.length > 1 && /^(hc|hs|hors-serie|integrale)$/.test(low[low.length - 1])) {
    const tag = { hc: "HC", hs: "HS", "hors-serie": "HS", integrale: "Intégrale" }[low[low.length - 1]];
    return { name: raw.slice(0, -1).join(" ").replace(/[\s,–-]+$/, ""), num: tag, nums: [tag] };
  }
  let i = raw.length;
  while (i > 0 && (isNumTok(low[i - 1]) || LINKS.has(low[i - 1]) || low[i - 1] === "")) i--;
  while (i < raw.length && LINKS.has(low[i])) i++; // le nombre ne commence pas par « et »
  const nums = i < raw.length && i > 0 ? readNumbers(low.slice(i)) : [];
  if (!nums.length) return { name: s, num: null, nums: [] };
  let j = i;
  while (j > 1 && (KEYWORDS.has(low[j - 1]) || low[j - 1] === "")) j--;
  const name = raw.slice(0, j).join(" ").replace(/[\s,–#-]+$/, "");
  return name ? { name, num: nums[0], nums } : { name: s, num: null, nums: [] };
}
function bestSeries(name, n = 3) {
  return db.series.map((x) => ({ s: x, score: Math.max(similarity(name, x.titre), similarity(x.titre, name) * 0.9) }))
    .filter((r) => r.score > 0.35).sort((a, b) => b.score - a.score).slice(0, n);
}

// ---------- calcul des manques ----------
const numeric = (arr) => (arr || []).filter((x) => typeof x === "number" || /^\d+$/.test(String(x))).map(Number);
function missingOf(s) {
  if (s.type === "integrale") return [];
  const owned = new Set(numeric(s.possedes));
  if (!owned.size && !s.parus) return [];
  const max = Math.max(s.parus || 0, ...owned);
  const start = owned.has(0) ? 0 : 1;
  const out = [];
  for (let i = start; i <= max; i++) if (!owned.has(i)) out.push(i);
  return out;
}
const has = (s, num) => (s.possedes || []).some((x) => String(x) === String(num));
const numLabel = (s, n) => (typeof n === "string" ? n : s.type === "fascicule" ? `n° ${n}` : `tome ${n}`);
// [1,2,3,5,7,8] -> "1-3, 5, 7-8"
function ranges(arr) {
  const out = []; let i = 0;
  while (i < arr.length) { let j = i; while (j + 1 < arr.length && arr[j + 1] === arr[j] + 1) j++; out.push(i === j ? `${arr[i]}` : `${arr[i]}-${arr[j]}`); i = j + 1; }
  return out.join(", ");
}

// ---------- couvertures ----------
const coverQueue = [];
let coverBusy = false;
function coverKey(s) { return s.id; }
function seriesCover(s) {
  if (s.cover) return s.cover;
  const eds = Object.values(s.editions || {}).find((e) => e.cover);
  if (eds) return eds.cover;
  const c = covers[coverKey(s)];
  return c && !c.startsWith("none") ? c : null;
}
// « rien trouvé » est retenu 30 jours, puis on réessaie (les bases s'enrichissent)
const recentlyTried = (id) => { const c = covers[id]; return (typeof c === "string" && c.startsWith("none:") && Date.now() - Number(c.slice(5)) < 30 * 864e5); };
function wantCover(s) {
  if (seriesCover(s) || recentlyTried(s.id) || !navigator.onLine) return;
  if (!coverQueue.includes(s.id)) coverQueue.push(s.id);
  pumpCovers();
}
async function pumpCovers() {
  if (coverBusy) return; coverBusy = true;
  while (coverQueue.length) {
    const id = coverQueue.shift();
    const s = db.series.find((x) => x.id === id);
    if (!s || seriesCover(s) || recentlyTried(id)) continue;
    const first = numeric(s.possedes).sort((a, b) => a - b)[0];
    let cands = await searchBases(s.titre, first ?? null, s.editeur, 6).catch(() => null);
    if (cands === null) { coverQueue.unshift(id); break; } // hors ligne ou quota : on réessaiera plus tard
    let pick = cands.find((c) => c.cover && c.score > 1.2);
    if (!pick) { // deuxième essai : le nom de la série seul, avec l'éditeur
      cands = await searchBases(s.titre, null, s.editeur, 6, `intitle:${s.titre}${s.editeur ? ` inpublisher:${s.editeur.split(" ")[0]}` : ""}`).catch(() => null);
      if (cands === null) { coverQueue.unshift(id); break; }
      pick = cands.find((c) => c.cover && c.score > 1.2);
    }
    covers[id] = pick ? pick.cover : `none:${Date.now()}`; // « rien trouvé » : on réessaiera dans 30 jours
    save(COVERS_KEY, covers);
    document.querySelectorAll(`[data-cover="${CSS.escape(id)}"]`).forEach((el) => paintCover(el, s));
    await new Promise((r) => setTimeout(r, 700));
  }
  coverBusy = false;
}
// Seules les images https et les photos prises dans l'appli sont affichées (pas d'adresse piégée venue d'un import).
const safeImg = (u) => (typeof u === "string" && /^(https:\/\/|data:image\/(jpeg|png|webp);)/i.test(u) ? u : null);
function paintCover(el, s) {
  const url = safeImg(seriesCover(s));
  el.innerHTML = url ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<svg class="ico"><use href="#${genreIcon(s.genre)}"/></svg>`;
}
const io = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
  entries.forEach((e) => { if (e.isIntersecting) { const s = db.series.find((x) => x.id === e.target.dataset.cover); if (s) wantCover(s); io.unobserve(e.target); } });
}, { rootMargin: "200px" }) : null;

// ---------- recherche dans les bases ----------
const https = (u) => (u ? u.replace(/^http:/, "https:").replace("&edge=curl", "") : null);
async function googleBooks(q, max) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=${max}&printType=books`;
  const r = await fetch(url); if (!r.ok) throw new Error("google " + r.status);
  const j = await r.json();
  return (j.items || []).map((it) => {
    const v = it.volumeInfo || {};
    const isbn = (v.industryIdentifiers || []).find((x) => x.type === "ISBN_13") || (v.industryIdentifiers || [])[0];
    return { source: "Google Books", titre: [v.title, v.subtitle].filter(Boolean).join(" – "), editeur: v.publisher || "",
      annee: (v.publishedDate || "").slice(0, 4), auteurs: (v.authors || []).join(", "), isbn: isbn?.identifier || "",
      cover: https(v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail) };
  });
}
async function openLibrary(q, max) {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=${max}&fields=title,subtitle,publisher,first_publish_year,author_name,cover_i,isbn`;
  const r = await fetch(url); if (!r.ok) throw new Error("ol " + r.status);
  const j = await r.json();
  return (j.docs || []).map((d) => ({ source: "Open Library", titre: [d.title, d.subtitle].filter(Boolean).join(" – "),
    editeur: (d.publisher || [])[0] || "", annee: d.first_publish_year ? String(d.first_publish_year) : "",
    auteurs: (d.author_name || []).slice(0, 3).join(", "), isbn: (d.isbn || [])[0] || "",
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null }));
}
function rank(c, name, num, editeur) {
  let sc = similarity(name, c.titre) * 3;
  if (num != null && new RegExp(`(^|\\D)0*${num}(\\D|$)`).test(c.titre)) sc += 1.5;
  if (editeur && norm(c.editeur).includes(norm(editeur).split(" ")[0])) sc += 0.6;
  if (c.cover) sc += 0.4;
  return sc;
}
async function searchBases(name, num, editeur, max = 6, query) {
  const q = query || (num != null ? `${name} ${num}` : name);
  const olq = num != null ? `${name} ${num}` : name; // la syntaxe intitle:/inpublisher: n'existe que chez Google
  const res = await Promise.allSettled([googleBooks(q, 8), openLibrary(olq, 6)]);
  if (res.every((r) => r.status === "rejected")) throw new Error("offline");
  const all = res.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const seen = new Set();
  return all.filter((c) => { const k = c.isbn || norm(c.titre + c.editeur); if (seen.has(k)) return false; seen.add(k); return true; })
    .map((c) => ({ ...c, score: rank(c, name, num, editeur) })).sort((a, b) => b.score - a.score).slice(0, max);
}

// ---------- rendu ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let filterM = "Tout", filterC = "Tout";

function chips(el, current, onPick) {
  el.innerHTML = ["Tout", ...GENRES.map((g) => g.id)].map((g) =>
    `<button class="chip" data-g="${esc(g)}" aria-pressed="${g === current}">${g === "Tout" ? "" : `<svg class="ico"><use href="#${genreIcon(g)}"/></svg>`}${esc(g)}</button>`).join("");
  el.onclick = (e) => { const b = e.target.closest(".chip"); if (b) onPick(b.dataset.g); };
}
function serieRow(s, extra, count) {
  return `<button class="serie" data-id="${esc(s.id)}">
    <span class="cover" data-cover="${esc(s.id)}"></span>
    <span class="meta"><span class="name">${esc(s.titre)}</span>
      <span class="sub">${esc([s.editeur, s.collection].filter(Boolean).join(" · "))}${s.aConfirmer ? ` <span class="flag">· à confirmer</span>` : ""}</span>
      ${extra || ""}</span>
    <span class="count">${esc(count ?? (s.possedes || []).length)}</span></button>`;
}
function hydrateCovers(root) {
  root.querySelectorAll("[data-cover]").forEach((el) => {
    const s = db.series.find((x) => x.id === el.dataset.cover); if (!s) return;
    paintCover(el, s); if (!seriesCover(s) && io) io.observe(el);
  });
}
const sortFr = (a, b) => a.titre.localeCompare(b.titre, "fr", { sensitivity: "base" });

let sortM = "az";
function renderManques() {
  chips($("#chips-manques"), filterM, (g) => { filterM = g; renderManques(); });
  $("#sort-manques").innerHTML = [["az", "A à Z"], ["near", "Presque complètes"]].map(([k, l]) =>
    `<button class="chip" data-sort="${k}" aria-pressed="${k === sortM}">${l}</button>`).join("");
  // Pendant une recherche « Est-ce que je l'ai ? », la liste ne garde que les séries concernées.
  const q = $("#q").value.trim();
  const hits = q ? new Set(bestSeries(parseLine(q)?.name || q, 8).map((r) => r.s.id)) : null;
  const pool = db.series.filter((s) => (filterM === "Tout" || s.genre === filterM) && (!hits || hits.has(s.id)));
  const wishes = pool.filter((s) => (s.souhaits || []).length);
  $("#wish-block").innerHTML = wishes.length ? `<h2 class="h2">Liste de souhaits</h2><div class="list">${wishes.sort(sortFr).map((s) =>
    serieRow(s, `<span class="gaps-txt wish">Souhaits : ${esc(s.souhaits.join(", "))}</span>`)).join("")}</div>` : "";
  const rows = pool.map((s) => ({ s, miss: missingOf(s) })).filter((r) => r.miss.length)
    .sort((a, b) => (!!a.s.aConfirmer - !!b.s.aConfirmer) || (sortM === "near" ? a.miss.length - b.miss.length : 0) || sortFr(a.s, b.s)); // « à confirmer » en fin de liste
  const list = $("#list-manques");
  list.innerHTML = rows.length ? rows.map(({ s, miss }) => {
    const total = numeric(s.possedes).length + miss.length;
    return serieRow(s, `<span class="gaps-txt">Il manque ${s.type === "fascicule" ? "n° " : ""}${esc(ranges(miss))}</span>`,
      `${numeric(s.possedes).length}/${total}`);
  }).join("")
    : `<p class="empty">${db.series.length ? "Aucun trou dans tes séries pour ce filtre." : "Ta collection est vide. Va dans Réglages pour importer ton fichier."}</p>`;
  hydrateCovers($("#v-manques"));
}

function renderAnswer() {
  const q = $("#q").value.trim(); const box = $("#answer");
  if (!q) { box.hidden = true; return; }
  const p = parseLine(q);
  // Toutes les séries qui ressemblent autant que la meilleure (« Conan 12 » -> Super Conan, Conan Lug, Cimmérien…)
  // avec un numéro, on ignore les intégrales et les livres isolés (« Nos années Strange » pour « Strange 74 »)
  const all = bestSeries(p.name, 10).filter((r) => p.num == null || (!["integrale", "livre", "roman"].includes(r.s.type) && numeric(r.s.possedes).length));
  const found = all.filter((r) => r.score >= all[0]?.score - 0.12).slice(0, 6);
  box.hidden = false;
  const addUnknown = `<button class="btn primary" data-addnew="${esc(q)}">Je l'achète : l'ajouter</button>`;
  if (!found.length) {
    box.innerHTML = `<span class="verdict big miss">NON</span><span class="hint">Tu n'as aucune série qui ressemble à « ${esc(p.name)} ».</span>
      <div class="row wrap-row">${addUnknown}</div>`;
    return;
  }
  if (p.num == null) {
    box.innerHTML = found.map(({ s }) => {
      const miss = missingOf(s);
      return `<button class="verdict-row" data-open="${esc(s.id)}"><span class="v-name">${esc(s.titre)}</span>
        <span class="v-sub">${miss.length ? `Il te manque ${esc(ranges(miss))}` : "Rien ne manque"}</span></button>`;
    }).join("");
    return;
  }
  box.innerHTML = found.map(({ s }) => {
    const ok = has(s, p.num);
    return `<div class="verdict-row ${ok ? "have" : "miss"}">
      <span class="v-big">${ok ? "OUI" : "NON"}</span>
      <button class="v-name" data-open="${esc(s.id)}">${esc(s.titre)} · ${esc(numLabel(s, p.num))}</button>
      ${ok ? "" : `<button class="btn primary" data-addnow="${esc(s.id)}" data-num="${esc(p.num)}">Je l'achète</button>`}
    </div>`;
  }).join("") + `<div class="row wrap-row"><span class="hint">Pas la bonne série ?</span>${addUnknown.replace("btn primary", "btn")}</div>`;
}

function renderCollection() {
  chips($("#chips-collection"), filterC, (g) => { filterC = g; renderCollection(); });
  const q = norm($("#qc").value);
  const rows = db.series.filter((s) => (filterC === "Tout" || s.genre === filterC) &&
    (!q || norm([s.titre, s.auteurs, s.editeur, s.collection].join(" ")).includes(q))).sort(sortFr);
  $("#list-collection").innerHTML = rows.length ? rows.map((s) => serieRow(s)).join("") : `<p class="empty">Aucune série ne correspond.</p>`;
  hydrateCovers($("#v-collection"));
}

function renderStat() {
  const vol = db.series.reduce((n, s) => n + (s.possedes || []).length, 0);
  $("#stat").textContent = db.series.length ? `${db.series.length} séries · ${vol} volumes` : "";
}
function renderAll() { renderStat(); renderManques(); renderAnswer(); renderCollection(); if (typeof renderBackup === "function") renderBackup(); }

// ---------- fiche série ----------
// Titres des tomes et éditions choisies, tome par tome
function detailList(s) {
  const keys = sortTomes([...Object.keys(s.titres || {}), ...Object.keys(s.editions || {}), ...(s.possedes || [])]);
  const rows = keys.map((k) => {
    const ed = (s.editions || {})[k]; const titre = (s.titres || {})[k];
    if (!ed && !titre) return "";
    const owned = has(s, k);
    const info = ed ? [ed.editeur, ed.annee, ed.isbn && `ISBN ${ed.isbn}`].filter(Boolean).join(" · ") : "";
    return `<li class="drow${owned ? "" : " not"}"><span class="dnum">${esc(k)}</span>
      <span>${safeImg(ed?.cover) ? `<img class="dcov" src="${esc(ed.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}</span>
      <span class="dtxt"><span>${esc(titre || ed?.titre || "")}</span>${info ? `<span class="hint">${esc(info)}</span>` : ""}</span>
      <span class="dst">${owned ? "✓" : ""}</span></li>`;
  }).join("");
  return rows ? `<details class="details"${keys.length <= 20 ? " open" : ""}><summary>Titres et éditions</summary><ul class="dlist">${rows}</ul></details>` : "";
}
let wishMode = false;
function openSerie(id) {
  const s = db.series.find((x) => x.id === id); if (!s) return;
  const dlg = $("#detail");
  const nums = numeric(s.possedes);
  const wish = new Set((s.souhaits || []).map(String));
  const max = Math.max(s.parus || 0, ...nums, ...[...wish].filter((x) => /^\d+$/.test(x)).map(Number), 0);
  const start = nums.includes(0) ? 0 : 1;
  const grid = [];
  for (let i = start; i <= max + 1; i++) {
    const st = has(s, i) ? "have" : wish.has(String(i)) ? "wish" : i <= max ? "miss" : "";
    const titre = s.titres?.[i] ? ` – ${s.titres[i]}` : "";
    grid.push(`<button class="tome ${st}" data-n="${i}" title="Tome ${i}${esc(titre)}" aria-label="Tome ${i}${esc(titre)} : ${st === "have" ? "possédé" : st === "wish" ? "souhaité" : "manquant"}">${i}</button>`);
  }
  const others = (s.possedes || []).filter((x) => !/^\d+$/.test(String(x)));
  dlg.innerHTML = `<div class="sheet-inner">
    <div class="row"><h2>${esc(s.titre)}</h2><button class="btn small" data-close>Fermer</button></div>
    <div class="row" style="justify-content:flex-start;align-items:flex-start">
      <span class="cover" data-cover="${esc(s.id)}" style="width:72px;height:98px"></span>
      <div class="meta"><div>${esc(s.auteurs || "")}</div><div class="hint">${esc([s.editeur, s.collection].filter(Boolean).join(" · "))}</div>
      ${s.note ? `<div class="hint">${esc(s.note)}</div>` : ""}</div></div>
    ${s.type !== "integrale" ? `<div class="row wrap-row legend"><span>${wishMode ? "Touche un numéro pour le mettre ou l'enlever de tes souhaits." : "Touche un numéro : je l'ai / je ne l'ai pas."}</span>
      <button class="btn small${wishMode ? " primary" : ""}" data-wishmode aria-pressed="${wishMode}"><svg class="ico"><use href="#i-star"/></svg>Souhaits</button></div>
    <div class="tomes">${grid.join("")}</div>` : ""}
    ${others.length ? `<div><div class="hint">Autres volumes</div><div class="extra">${others.map((o) => `<span class="tome have">${esc(o)}</span>`).join("")}</div></div>` : ""}
    ${detailList(s)}
    <div class="grid2">
      <label class="field">Tomes parus (pour voir les manques au-delà)<input id="f-parus" type="number" min="0" inputmode="numeric" value="${esc(s.parus || "")}"></label>
      <label class="field">Éditeur<input id="f-editeur" value="${esc(s.editeur)}"></label>
      <label class="field">Collection<input id="f-collection" value="${esc(s.collection)}"></label>
      <label class="field">Genre<select id="f-genre" class="field-select">${GENRES.map((g) => `<option${g.id === s.genre ? " selected" : ""}>${g.id}</option>`).join("")}</select></label>
    </div>
    <div class="row wrap-row">
      <button class="btn primary" data-savemeta>Enregistrer</button>
      <button class="btn" data-recover>Chercher une couverture</button>
      <label class="btn">Photographier la couverture<input id="f-photo" type="file" accept="image/*" capture="environment" hidden></label>
      <button class="btn danger" data-del>Supprimer la série</button>
    </div>
    <div class="row" data-delconfirm hidden><span>Supprimer « ${esc(s.titre)} » ?</span><button class="btn danger small" data-delyes>Oui</button><button class="btn small" data-delno>Non</button></div>
    <div data-covers></div>
  </div>`;
  hydrateCovers(dlg);
  // Chaque champ est enregistré dès qu'on le quitte : rien ne se perd si on touche un tome ensuite.
  const meta = () => {
    s.parus = Number($("#f-parus").value) || null; s.editeur = $("#f-editeur").value.trim();
    s.collection = $("#f-collection").value.trim(); s.genre = $("#f-genre").value; save(KEY, db); renderAll();
  };
  dlg.querySelectorAll("#f-parus, #f-editeur, #f-collection, #f-genre").forEach((el) => (el.onchange = meta));
  dlg.onclose = () => { wishMode = false; };
  dlg.querySelector("#f-photo").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { s.cover = await shrink(f); persist(); toast("Couverture enregistrée"); openSerie(s.id); }
    catch { toast("Impossible de lire cette photo."); }
  };
  dlg.onclick = async (e) => {
    const t = e.target;
    if (t === dlg || t.closest("[data-close]")) return dlg.close();
    const tome = t.closest(".tome[data-n]");
    if (tome) {
      const n = Number(tome.dataset.n);
      const before = { possedes: [...(s.possedes || [])], souhaits: [...(s.souhaits || [])] };
      const isWish = (s.souhaits || []).map(String).includes(String(n));
      if (wishMode) {
        if (has(s, n)) return toast("Tu l'as déjà : il ne peut pas être en souhait.");
        s.souhaits = isWish ? s.souhaits.filter((x) => String(x) !== String(n)) : sortTomes([...(s.souhaits || []), n]);
        persist(); return openSerie(s.id);
      }
      if (has(s, n)) s.possedes = s.possedes.filter((x) => String(x) !== String(n));
      else { s.possedes = sortTomes([...(s.possedes || []), n]); s.souhaits = (s.souhaits || []).filter((x) => String(x) !== String(n)); }
      persist(); openSerie(s.id);
      const lbl = numLabel(s, n).replace(/^./, (c) => c.toUpperCase());
      return toast(has(s, n) ? `${lbl} ajouté` : `${lbl} retiré de ta collection`,
        () => { Object.assign(s, before); persist(); if (dlg.open) openSerie(s.id); });
    }
    if (t.closest("[data-wishmode]")) { wishMode = !wishMode; return openSerie(s.id); }
    if (t.closest("[data-savemeta]")) { meta(); toast("Enregistré"); return openSerie(s.id); }
    if (t.closest("[data-del]")) { dlg.querySelector("[data-delconfirm]").hidden = false; return; }
    if (t.closest("[data-delno]")) { dlg.querySelector("[data-delconfirm]").hidden = true; return; }
    if (t.closest("[data-delyes]")) { db.series = db.series.filter((x) => x.id !== s.id); persist(); dlg.close(); return toast("Série supprimée"); }
    if (t.closest("[data-recover]")) {
      const box = dlg.querySelector("[data-covers]"); box.innerHTML = `<p class="hint">Recherche…</p>`;
      try {
        const cands = (await searchBases(s.titre, numeric(s.possedes)[0] ?? null, s.editeur, 10)).filter((c) => c.cover);
        box.innerHTML = cands.length ? `<div class="cands">${cands.map((c, i) => candHtml(c, i)).join("")}</div>` : `<p class="hint">Aucune couverture trouvée.</p>`;
        box.querySelector(".cands")?.addEventListener("click", (ev) => {
          const b = ev.target.closest(".cand"); if (!b) return;
          s.cover = cands[Number(b.dataset.i)].cover; persist(); openSerie(s.id);
        });
      } catch { box.innerHTML = `<p class="hint">Pas de connexion : réessaie plus tard.</p>`; }
    }
  };
  if (!dlg.open) dlg.showModal();
}
// Réduit une photo à une petite vignette (environ 10 Ko) pour la garder dans le navigateur.
async function shrink(file, w = 180) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = url; });
    const h = Math.round((img.height / img.width) * w);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.72);
  } finally { URL.revokeObjectURL(url); }
}
function removeVolume(s, num) {
  s.possedes = (s.possedes || []).filter((x) => String(x) !== String(num)); persist();
}
function sortTomes(arr) {
  return [...new Set(arr.map((x) => (/^\d+$/.test(String(x)) ? Number(x) : x)))].sort((a, b) =>
    typeof a === "number" && typeof b === "number" ? a - b : typeof a === "number" ? -1 : typeof b === "number" ? 1 : String(a).localeCompare(String(b)));
}

// ---------- ajout ----------
function candHtml(c, i) {
  return `<button class="cand${i === 0 ? " best" : ""}" data-i="${i}">
    ${i === 0 ? `<span class="badge">Meilleure</span>` : ""}
    <span class="cimg">${safeImg(c.cover) ? `<img src="${esc(c.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<svg class="ico"><use href="#i-book"/></svg>`}</span>
    <span class="t">${esc(c.titre || "Sans titre")}</span>
    <span class="s">${esc([c.editeur, c.annee].filter(Boolean).join(" · "))}</span>
    <span class="s">${esc(c.source)}</span></button>`;
}
function slug(t) { let b = norm(t).replace(/ /g, "-") || "serie", id = b, i = 2; while (db.series.some((x) => x.id === id)) id = `${b}-${i++}`; return id; }
function addVolume({ serieId, newName, genre, num, cand, wish }) {
  let s = serieId ? db.series.find((x) => x.id === serieId) : null;
  if (!s) {
    s = { id: slug(newName), genre: genre || "Fantasy", titre: newName, editeur: cand?.editeur || "", collection: "", auteurs: cand?.auteurs || "",
      type: "album", possedes: [], titres: {}, note: "", aConfirmer: false, souhaits: [] };
    db.series.push(s);
  }
  const key = num ?? (cand?.titre || "1");
  if (wish) s.souhaits = sortTomes([...(s.souhaits || []), key]);
  else { s.possedes = sortTomes([...(s.possedes || []), key]); s.souhaits = (s.souhaits || []).filter((x) => String(x) !== String(key)); }
  if (cand) {
    s.editions = s.editions || {};
    s.editions[key] = { titre: cand.titre, editeur: cand.editeur, annee: cand.annee, isbn: cand.isbn, cover: cand.cover, source: cand.source };
    if (!s.editeur && cand.editeur) s.editeur = cand.editeur;
  }
  persist();
  return s;
}
async function runSearch() {
  const lines = $("#saisie").value.split(/\n|;|(?:\s+et\s+puis\s+)/).map(parseLine).filter(Boolean)
    .flatMap((p) => (p.nums.length > 1 ? p.nums.map((n) => ({ ...p, num: n })) : [p]));
  const out = $("#results");
  if (!lines.length) { out.innerHTML = `<p class="hint">Écris ou dicte au moins un album.</p>`; return; }
  const wish = $("#as-wish").checked;
  out.innerHTML = "";
  for (const p of lines) {
    const block = document.createElement("div"); block.className = "query"; out.append(block);
    // Les séries proches sont proposées, mais on ne range d'office dans une série existante que si le nom est quasi identique
    // (sinon « Lanfeust des étoiles » finirait dans « Lanfeust de Troy »).
    const near = bestSeries(p.name, 3).filter((r) => r.score > 0.55);
    const sure = near[0] && (norm(near[0].s.titre) === norm(p.name) || near[0].score >= 0.85) ? near[0].s : null;
    const label = `${p.name}${p.num != null ? ` · ${numLabel(sure || {}, p.num)}` : ""}`;
    const genreSel = `<select data-genre>${GENRES.map((g) => `<option>${g.id}</option>`).join("")}</select>`;
    const choice = `<select data-target>${near.map((r) => `<option value="${esc(r.s.id)}"${r.s === sure ? " selected" : ""}>Dans ma série « ${esc(r.s.titre)} »</option>`).join("")}
      <option value=""${sure ? "" : " selected"}>Nouvelle série « ${esc(p.name)} »</option></select>`;
    block.innerHTML = `<h3>${esc(label)}</h3><div class="target">${near.length ? choice : `Nouvelle série « ${esc(p.name)} »`}<span data-genre-wrap${sure ? " hidden" : ""}> · genre ${genreSel}</span></div><p class="hint">Recherche dans les bases…</p>`;
    const tsel = block.querySelector("[data-target]");
    const checkDup = () => {
      const t = db.series.find((x) => x.id === tsel?.value);
      block.querySelector("[data-genre-wrap]").hidden = !!t;
      block.querySelector("[data-dup]")?.remove();
      if (t && p.num != null && has(t, p.num) && !wish) block.querySelector(".target").insertAdjacentHTML("afterend", `<p class="done" data-dup>Tu l'as déjà.</p>`);
    };
    if (tsel) { tsel.onchange = checkDup; checkDup(); }
    let cands = [];
    try { cands = await searchBases(p.name, p.num, sure?.editeur, 6); } // toujours avec le texte saisi
    catch { cands = []; }
    const hint = block.querySelector(".hint"); if (hint) hint.remove();
    const wrap = document.createElement("div");
    wrap.innerHTML = `${cands.length ? `<p class="hint">Choisis la bonne édition (la première est la plus probable) :</p><div class="cands">${cands.map((c, i) => candHtml(c, i)).join("")}</div>` : `<p class="hint">Rien trouvé dans les bases (ou pas de réseau).</p>`}
      <div class="row wrap-row"><button class="btn small" data-plain>Ajouter sans édition précise</button></div>`;
    block.append(wrap);
    const done = (s) => { wrap.innerHTML = `<p class="done">${wish ? "Ajouté aux souhaits" : "Ajouté"} : ${esc(s.titre)}${p.num != null ? ` ${esc(numLabel(s, p.num))}` : ""}</p>`; };
    wrap.onclick = (e) => {
      const b = e.target.closest(".cand"); const plain = e.target.closest("[data-plain]");
      if (!b && !plain) return;
      const genre = block.querySelector("[data-genre]")?.value;
      if (tsel) tsel.disabled = true;
      done(addVolume({ serieId: tsel?.value || null, newName: p.name, genre, num: p.num, cand: b ? cands[Number(b.dataset.i)] : null, wish }));
    };
  }
}

// dictée vocale du navigateur (Chrome Android, Edge, Safari récent)
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
$("#mic").addEventListener("click", () => {
  if (!SR) return toast("Dictée non disponible ici : utilise le micro de ton clavier.");
  if (rec) { rec.stop(); return; }
  rec = new SR(); rec.lang = "fr-FR"; rec.interimResults = false; rec.continuous = false;
  $("#mic").classList.add("live");
  rec.onresult = (e) => {
    const said = Array.from(e.results).map((r) => r[0].transcript).join(" ").trim();
    const ta = $("#saisie"); ta.value = (ta.value.trim() ? ta.value.trim() + "\n" : "") + said;
  };
  rec.onerror = (e) => toast(e.error === "not-allowed" ? "Autorise le micro pour dicter." : "La dictée s'est arrêtée.");
  rec.onend = () => { $("#mic").classList.remove("live"); rec = null; };
  rec.start();
});

// ---------- partage famille (texte, sans serveur) ----------
function shareText() {
  const fmt = (s, list) => `- ${s.titre}${s.editeur ? ` (${s.editeur})` : ""} : ${s.type === "fascicule" ? "n° " : ""}${list}`;
  const known = db.series.filter((s) => !s.aConfirmer);
  const wishes = known.filter((s) => (s.souhaits || []).length).sort(sortFr).map((s) => fmt(s, s.souhaits.join(", ")));
  const miss = known.map((s) => ({ s, m: missingOf(s) })).filter((r) => r.m.length).sort((a, b) => sortFr(a.s, b.s))
    .map(({ s, m }) => fmt(s, ranges(m)));
  return [`Les BD qui me manquent (idées cadeaux) — mise à jour du ${new Date().toLocaleDateString("fr-FR")}`,
    wishes.length ? `\nCe que j'aimerais en priorité :\n${wishes.join("\n")}` : "",
    `\nTomes qui manquent à mes séries :\n${miss.join("\n")}`].filter(Boolean).join("\n");
}
async function shareList() {
  const text = shareText();
  try { if (navigator.share) { await navigator.share({ title: "Mes BD qui manquent", text }); return; } } catch (e) { if (e.name === "AbortError") return; }
  try { await navigator.clipboard.writeText(text); toast("Liste copiée : colle-la dans un SMS ou WhatsApp."); }
  catch { toast("Partage impossible sur cet appareil."); }
}
document.querySelectorAll("[data-share]").forEach((b) => b.addEventListener("click", shareList));

// ---------- rappel de sauvegarde ----------
function renderBackup() {
  const days = meta.lastExport ? (Date.now() - meta.lastExport) / 864e5 : Infinity;
  const due = db.series.length && meta.changes >= 15 && (days > 7 || meta.changes >= 50);
  $("#backup").hidden = !due;
  if (due) $("#backup-txt").textContent = `${meta.changes} changements depuis ta dernière sauvegarde. Ta collection n'existe que sur ce téléphone : garde une copie.`;
  $("#last-exp").textContent = meta.lastExport ? `Dernière sauvegarde : ${new Date(meta.lastExport).toLocaleDateString("fr-FR")}.` : "Aucune sauvegarde pour l'instant.";
}

// ---------- import / export ----------
function mergeImport(data) {
  const incoming = Array.isArray(data) ? data : data.series;
  if (!Array.isArray(incoming)) throw new Error("format");
  let added = 0, replaced = 0;
  for (const s of incoming) {
    if (!s || !s.titre) continue;
    s.possedes = s.possedes || []; s.souhaits = s.souhaits || []; s.genre = s.genre || "Fantasy";
    const i = db.series.findIndex((x) => norm(x.titre) === norm(s.titre));
    if (i >= 0) {
      const old = db.series[i];
      s.id = old.id;
      s.possedes = sortTomes([...(old.possedes || []), ...s.possedes]); // on n'efface jamais ce qui a été ajouté dans l'appli
      s.souhaits = sortTomes([...(old.souhaits || []), ...s.souhaits]).filter((x) => !s.possedes.map(String).includes(String(x)));
      db.series[i] = { ...old, ...s, cover: old.cover || s.cover, editions: { ...(s.editions || {}), ...(old.editions || {}) } };
      replaced++;
    }
    else { s.id = s.id && !db.series.some((x) => x.id === s.id) ? s.id : slug(s.titre); db.series.push(s); added++; }
  }
  persist();
  return { added, replaced };
}
$("#imp").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const r = mergeImport(JSON.parse(await f.text()));
    $("#imp-msg").textContent = `Import terminé : ${r.added} séries ajoutées, ${r.replaced} mises à jour.`;
  } catch { $("#imp-msg").textContent = "Ce fichier n'est pas une collection valide."; }
  e.target.value = "";
});
function exportFile() {
  const blob = new Blob([JSON.stringify(db, null, 1)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `ma-collection-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  meta = { changes: 0, lastExport: Date.now() }; save(META_KEY, meta); renderBackup();
  toast("Fichier enregistré dans tes Téléchargements.");
}
document.querySelectorAll("#exp, [data-export]").forEach((b) => b.addEventListener("click", exportFile));
$("#backup-later").addEventListener("click", () => { meta.changes = 0; save(META_KEY, meta); renderBackup(); });
$("#clear-covers").addEventListener("click", () => { covers = {}; save(COVERS_KEY, covers); renderAll(); toast("Les couvertures vont être recherchées à nouveau."); });
$("#wipe").addEventListener("click", () => { $("#wipe-confirm").hidden = false; });
$("#wipe-no").addEventListener("click", () => { $("#wipe-confirm").hidden = true; });
$("#wipe-yes").addEventListener("click", () => { db = { version: 1, series: [] }; persist(); $("#wipe-confirm").hidden = true; toast("Collection effacée"); });

// ---------- navigation & évènements ----------
const VIEWS = ["manques", "collection", "ajouter", "reglages"];
function show(v) {
  document.querySelectorAll(".view").forEach((s) => (s.hidden = s.id !== "v-" + v));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.v === v));
  if (location.hash !== "#" + v) history.pushState(null, "", "#" + v); // le bouton retour d'Android revient à l'écran précédent
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (VIEWS.includes(v)) show(v); });
document.querySelector(".tabs").addEventListener("click", (e) => { const t = e.target.closest(".tab"); if (t) show(t.dataset.v); });
$("#main").addEventListener("click", (e) => {
  const add = e.target.closest("[data-addnow]");
  if (add) {
    const num = /^\d+$/.test(add.dataset.num) ? Number(add.dataset.num) : add.dataset.num;
    const s = addVolume({ serieId: add.dataset.addnow, num });
    return toast(`Ajouté : ${s.titre} ${numLabel(s, num)}`, () => { removeVolume(s, num); });
  }
  const addNew = e.target.closest("[data-addnew]");
  if (addNew) { $("#saisie").value = addNew.dataset.addnew; $("#as-wish").checked = false; show("ajouter"); return runSearch(); }
  const open = e.target.closest("[data-open], .serie");
  if (open) openSerie(open.dataset.open || open.dataset.id);
});
$("#q").addEventListener("input", () => { renderAnswer(); renderManques(); });
$("#qc").addEventListener("input", renderCollection);
$("#sort-manques").addEventListener("click", (e) => { const b = e.target.closest("[data-sort]"); if (b) { sortM = b.dataset.sort; renderManques(); } });
$("#go").addEventListener("click", runSearch);
window.addEventListener("online", () => pumpCovers());

let toastTimer;
// Message bref en bas de l'écran ; avec undo, un bouton « Annuler » reste 6 secondes.
function toast(msg, undo) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  const dlg = $("#detail"); (dlg.open ? dlg : document.body).append(t); // au-dessus de la fiche ouverte, sinon il n'est pas touchable
  if (undo) {
    const b = document.createElement("button"); b.className = "toast-undo"; b.textContent = "Annuler";
    b.onclick = () => { undo(); t.hidden = true; }; t.append(b);
  }
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), undo ? 6000 : 2600);
}

const start = (location.hash || "").slice(1);
const first = VIEWS.includes(start) ? start : db.series.length ? "manques" : "reglages";
history.replaceState(null, "", "#" + first); show(first);
renderAll();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// pour les tests
window.__gestio = { parseLine, similarity, missingOf, bestSeries, mergeImport, shareText };
