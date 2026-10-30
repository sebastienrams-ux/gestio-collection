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
const persist = () => { save(KEY, db); renderAll(); };
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
  onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16, "dix-sept": 17, "dix-huit": 18, "dix-neuf": 19, vingt: 20 };
// « Elfes tome 19 » -> { name: "Elfes", num: 19 }
function parseLine(line) {
  let s = line.trim().replace(/[.,;]+$/, "");
  if (!s) return null;
  s = s.replace(/\b(dix-sept|dix-huit|dix-neuf|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt)\s*$/i, (w) => NUM_WORDS[w.toLowerCase()]);
  const m = s.match(/^(.*?)(?:[\s,–-]+(?:tome|tomes|t\.?|n°|no\.?|num[ée]ro|num|volume|vol\.?|#|livre))?[\s#]*(\d{1,4})\s*$/i);
  if (m && m[1].trim()) return { name: m[1].trim().replace(/[\s,–-]+$/, ""), num: Number(m[2]) };
  return { name: s, num: null };
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

// ---------- couvertures ----------
const coverQueue = [];
let coverBusy = false;
function coverKey(s) { return s.id; }
function seriesCover(s) {
  if (s.cover) return s.cover;
  const eds = Object.values(s.editions || {}).find((e) => e.cover);
  if (eds) return eds.cover;
  return covers[coverKey(s)] || null;
}
function wantCover(s) {
  if (seriesCover(s) || covers[coverKey(s)] === "" || !navigator.onLine) return;
  if (!coverQueue.includes(s.id)) coverQueue.push(s.id);
  pumpCovers();
}
async function pumpCovers() {
  if (coverBusy) return; coverBusy = true;
  while (coverQueue.length) {
    const id = coverQueue.shift();
    const s = db.series.find((x) => x.id === id);
    if (!s || seriesCover(s) || covers[id] === "") continue;
    const first = numeric(s.possedes).sort((a, b) => a - b)[0];
    const cands = await searchBases(s.titre, first ?? null, s.editeur, 4).catch(() => null);
    if (cands === null) break; // hors ligne ou quota : on réessaiera plus tard
    const pick = cands.find((c) => c.cover);
    covers[id] = pick ? pick.cover : "";
    save(COVERS_KEY, covers);
    document.querySelectorAll(`[data-cover="${CSS.escape(id)}"]`).forEach((el) => paintCover(el, s));
    await new Promise((r) => setTimeout(r, 700));
  }
  coverBusy = false;
}
function paintCover(el, s) {
  const url = seriesCover(s);
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
async function searchBases(name, num, editeur, max = 6) {
  const q = num != null ? `${name} ${num}` : name;
  const res = await Promise.allSettled([googleBooks(q, 8), openLibrary(q, 6)]);
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
function serieRow(s, extra) {
  return `<button class="serie" data-id="${esc(s.id)}">
    <span class="cover" data-cover="${esc(s.id)}"></span>
    <span class="meta"><span class="name">${esc(s.titre)}</span>
      <span class="sub">${esc([s.editeur, s.collection].filter(Boolean).join(" · "))}${s.aConfirmer ? ` <span class="flag">· à confirmer</span>` : ""}</span>
      ${extra || ""}</span>
    <span class="count">${(s.possedes || []).length}</span></button>`;
}
function hydrateCovers(root) {
  root.querySelectorAll("[data-cover]").forEach((el) => {
    const s = db.series.find((x) => x.id === el.dataset.cover); if (!s) return;
    paintCover(el, s); if (!seriesCover(s) && io) io.observe(el);
  });
}
const sortFr = (a, b) => a.titre.localeCompare(b.titre, "fr", { sensitivity: "base" });

function renderManques() {
  chips($("#chips-manques"), filterM, (g) => { filterM = g; renderManques(); });
  const pool = db.series.filter((s) => filterM === "Tout" || s.genre === filterM);
  const wishes = pool.filter((s) => (s.souhaits || []).length);
  $("#wish-block").innerHTML = wishes.length ? `<h2 class="h2">Liste de souhaits</h2><div class="list">${wishes.sort(sortFr).map((s) =>
    serieRow(s, `<span class="gaps">${s.souhaits.map((n) => `<span class="num wish">${esc(n)}</span>`).join("")}</span>`)).join("")}</div>` : "";
  const rows = pool.map((s) => ({ s, miss: missingOf(s) })).filter((r) => r.miss.length).sort((a, b) => sortFr(a.s, b.s));
  const list = $("#list-manques");
  list.innerHTML = rows.length ? rows.map(({ s, miss }) => serieRow(s, `<span class="gaps">${miss.slice(0, 40).map((n) =>
    `<span class="num${(s.souhaits || []).map(String).includes(String(n)) ? " wish" : ""}">${n}</span>`).join("")}${miss.length > 40 ? `<span class="num">+${miss.length - 40}</span>` : ""}</span>`)).join("")
    : `<p class="empty">${db.series.length ? "Aucun trou dans tes séries pour ce filtre." : "Ta collection est vide. Va dans Réglages pour importer ton fichier."}</p>`;
  hydrateCovers($("#v-manques"));
}

function renderAnswer() {
  const q = $("#q").value.trim(); const box = $("#answer");
  if (!q) { box.hidden = true; return; }
  const p = parseLine(q); const found = bestSeries(p.name, 3);
  box.hidden = false;
  if (!found.length) { box.innerHTML = `<span class="verdict miss">Série inconnue dans ta collection</span><span class="hint">Tu n'as rien qui ressemble à « ${esc(p.name)} ».</span>`; return; }
  const s = found[0].s;
  let head;
  if (p.num != null) {
    head = has(s, p.num) ? `<span class="verdict have">Oui, tu as ${esc(s.titre)} tome ${p.num}</span>`
      : `<span class="verdict miss">Non, il te manque ${esc(s.titre)} tome ${p.num}</span>`;
  } else head = `<span class="verdict">${esc(s.titre)}</span>`;
  const owned = (s.possedes || []).join(", ") || "aucun";
  const miss = missingOf(s);
  box.innerHTML = `${head}<span class="hint">Tu as : ${esc(owned)}</span>${miss.length ? `<span class="hint">Il manque : ${miss.join(", ")}</span>` : ""}
    ${found.length > 1 ? `<span class="hint">Ou peut-être : ${found.slice(1).map((r) => esc(r.s.titre)).join(", ")}</span>` : ""}
    <div class="row wrap-row"><button class="btn small" data-open="${esc(s.id)}">Voir la série</button>
    ${p.num != null && !has(s, p.num) ? `<button class="btn small primary" data-addnow="${esc(s.id)}" data-num="${p.num}">Je l'achète</button>` : ""}</div>`;
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
function renderAll() { renderStat(); renderManques(); renderAnswer(); renderCollection(); }

// ---------- fiche série ----------
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
    ${s.type !== "integrale" ? `<div class="legend"><span>Touche un numéro : possédé, puis souhaité, puis manquant.</span></div>
    <div class="tomes">${grid.join("")}</div>` : ""}
    ${others.length ? `<div><div class="hint">Autres volumes</div><div class="extra">${others.map((o) => `<span class="tome have">${esc(o)}</span>`).join("")}</div></div>` : ""}
    <div class="grid2">
      <label class="field">Tomes parus (pour voir les manques au-delà)<input id="f-parus" type="number" min="0" inputmode="numeric" value="${s.parus || ""}"></label>
      <label class="field">Éditeur<input id="f-editeur" value="${esc(s.editeur)}"></label>
      <label class="field">Collection<input id="f-collection" value="${esc(s.collection)}"></label>
      <label class="field">Genre<select id="f-genre" class="field-select">${GENRES.map((g) => `<option${g.id === s.genre ? " selected" : ""}>${g.id}</option>`).join("")}</select></label>
    </div>
    <div class="row wrap-row">
      <button class="btn primary" data-savemeta>Enregistrer</button>
      <button class="btn" data-recover>Changer la couverture</button>
      <button class="btn danger" data-del>Supprimer la série</button>
    </div>
    <div class="row" data-delconfirm hidden><span>Supprimer « ${esc(s.titre)} » ?</span><button class="btn danger small" data-delyes>Oui</button><button class="btn small" data-delno>Non</button></div>
    <div data-covers></div>
  </div>`;
  hydrateCovers(dlg);
  dlg.onclick = async (e) => {
    const t = e.target;
    if (t === dlg || t.closest("[data-close]")) return dlg.close();
    const tome = t.closest(".tome[data-n]");
    if (tome) {
      const n = Number(tome.dataset.n);
      const w = (s.souhaits || []).map(String);
      if (has(s, n)) { s.possedes = s.possedes.filter((x) => String(x) !== String(n)); s.souhaits = [...(s.souhaits || []), n]; }
      else if (w.includes(String(n))) { s.souhaits = s.souhaits.filter((x) => String(x) !== String(n)); }
      else { s.possedes = sortTomes([...(s.possedes || []), n]); }
      persist(); return openSerie(s.id);
    }
    if (t.closest("[data-savemeta]")) {
      s.parus = Number($("#f-parus").value) || null; s.editeur = $("#f-editeur").value.trim();
      s.collection = $("#f-collection").value.trim(); s.genre = $("#f-genre").value;
      persist(); toast("Enregistré"); return openSerie(s.id);
    }
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
function sortTomes(arr) {
  return [...new Set(arr.map((x) => (/^\d+$/.test(String(x)) ? Number(x) : x)))].sort((a, b) =>
    typeof a === "number" && typeof b === "number" ? a - b : typeof a === "number" ? -1 : typeof b === "number" ? 1 : String(a).localeCompare(String(b)));
}

// ---------- ajout ----------
function candHtml(c, i) {
  return `<button class="cand${i === 0 ? " best" : ""}" data-i="${i}">
    ${i === 0 ? `<span class="badge">Meilleure</span>` : ""}
    <span class="cimg">${c.cover ? `<img src="${esc(c.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<svg class="ico"><use href="#i-book"/></svg>`}</span>
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
  const lines = $("#saisie").value.split(/\n|;|(?:\s+et\s+puis\s+)/).map(parseLine).filter(Boolean);
  const out = $("#results");
  if (!lines.length) { out.innerHTML = `<p class="hint">Écris ou dicte au moins un album.</p>`; return; }
  const wish = $("#as-wish").checked;
  out.innerHTML = "";
  for (const p of lines) {
    const block = document.createElement("div"); block.className = "query"; out.append(block);
    const match = bestSeries(p.name, 1)[0];
    const target = match && match.score > 0.55 ? match.s : null;
    const label = `${p.name}${p.num != null ? ` · tome ${p.num}` : ""}`;
    const genreSel = `<select data-genre>${GENRES.map((g) => `<option>${g.id}</option>`).join("")}</select>`;
    block.innerHTML = `<h3>${esc(label)}</h3><div class="target">${target ? `Sera ajouté à ta série « ${esc(target.titre)} »` : `Nouvelle série « ${esc(p.name)} », genre ${genreSel}`}</div><p class="hint">Recherche dans les bases…</p>`;
    if (target && p.num != null && has(target, p.num) && !wish) block.querySelector(".hint").outerHTML = `<p class="done">Tu l'as déjà.</p>`;
    let cands = [];
    try { cands = await searchBases(target ? target.titre : p.name, p.num, target?.editeur, 6); }
    catch { cands = []; }
    const hint = block.querySelector(".hint"); if (hint) hint.remove();
    const wrap = document.createElement("div");
    wrap.innerHTML = `${cands.length ? `<p class="hint">Choisis la bonne édition (la première est la plus probable) :</p><div class="cands">${cands.map((c, i) => candHtml(c, i)).join("")}</div>` : `<p class="hint">Rien trouvé dans les bases (ou pas de réseau).</p>`}
      <div class="row wrap-row"><button class="btn small" data-plain>Ajouter sans édition précise</button></div>`;
    block.append(wrap);
    const done = (s) => { wrap.innerHTML = `<p class="done">${wish ? "Ajouté aux souhaits" : "Ajouté"} : ${esc(s.titre)}${p.num != null ? ` tome ${p.num}` : ""}</p>`; };
    wrap.onclick = (e) => {
      const b = e.target.closest(".cand"); const plain = e.target.closest("[data-plain]");
      if (!b && !plain) return;
      const genre = block.querySelector("[data-genre]")?.value;
      done(addVolume({ serieId: target?.id, newName: p.name, genre, num: p.num, cand: b ? cands[Number(b.dataset.i)] : null, wish }));
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

// ---------- import / export ----------
function mergeImport(data) {
  const incoming = Array.isArray(data) ? data : data.series;
  if (!Array.isArray(incoming)) throw new Error("format");
  let added = 0, replaced = 0;
  for (const s of incoming) {
    if (!s || !s.titre) continue;
    s.possedes = s.possedes || []; s.souhaits = s.souhaits || []; s.genre = s.genre || "Fantasy";
    const i = db.series.findIndex((x) => norm(x.titre) === norm(s.titre));
    if (i >= 0) { s.id = db.series[i].id; db.series[i] = { ...db.series[i], ...s }; replaced++; }
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
$("#exp").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(db, null, 1)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `ma-collection-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$("#clear-covers").addEventListener("click", () => { covers = {}; save(COVERS_KEY, covers); renderAll(); toast("Les couvertures vont être recherchées à nouveau."); });
$("#wipe").addEventListener("click", () => { $("#wipe-confirm").hidden = false; });
$("#wipe-no").addEventListener("click", () => { $("#wipe-confirm").hidden = true; });
$("#wipe-yes").addEventListener("click", () => { db = { version: 1, series: [] }; persist(); $("#wipe-confirm").hidden = true; toast("Collection effacée"); });

// ---------- navigation & évènements ----------
function show(v) {
  document.querySelectorAll(".view").forEach((s) => (s.hidden = s.id !== "v-" + v));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.v === v));
  if (location.hash !== "#" + v) history.replaceState(null, "", "#" + v);
  window.scrollTo(0, 0);
}
document.querySelector(".tabs").addEventListener("click", (e) => { const t = e.target.closest(".tab"); if (t) show(t.dataset.v); });
$("#main").addEventListener("click", (e) => {
  const add = e.target.closest("[data-addnow]");
  if (add) { addVolume({ serieId: add.dataset.addnow, num: Number(add.dataset.num) }); return toast("Ajouté à ta collection"); }
  const open = e.target.closest("[data-open], .serie");
  if (open) openSerie(open.dataset.open || open.dataset.id);
});
$("#q").addEventListener("input", renderAnswer);
$("#qc").addEventListener("input", renderCollection);
$("#go").addEventListener("click", runSearch);
window.addEventListener("online", () => pumpCovers());

let toastTimer;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600); }

const start = (location.hash || "").slice(1);
show(["manques", "collection", "ajouter", "reglages"].includes(start) ? start : db.series.length ? "manques" : "reglages");
renderAll();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// pour les tests
window.__gestio = { parseLine, similarity, missingOf, bestSeries, mergeImport };
