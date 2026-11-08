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
// Sans couverture : un dos de livre en cuir, teinté selon le genre, avec les initiales de la série.
const SPINE = { Fantasy: "#6b3a2a", SF: "#2f4a5a", Comics: "#7a5a1a", "Autres BD": "#4a4a3a", "Hors BD": "#3f3550" };
const initials = (t) => tokens(t).filter((w) => !/^\d+$/.test(w)).slice(0, 3).map((w) => w[0].toUpperCase()).join("") || "?";
function spineHtml(s) {
  return `<span class="spine" style="--gc:${SPINE[s.genre] || SPINE["Autres BD"]}"><span>${esc(initials(s.titre))}</span></span>`;
}
function paintCover(el, s) {
  const url = safeImg(seriesCover(s));
  el.innerHTML = url ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : spineHtml(s);
  const img = el.querySelector("img");
  if (img) img.onerror = () => {
    if (covers[s.id] === url) { covers[s.id] = `none:${Date.now()}`; save(COVERS_KEY, covers); } // image devinée par ISBN qui n'existe pas
    el.innerHTML = spineHtml(s);
  };
}
const io = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
  entries.forEach((e) => { if (e.isIntersecting) { const s = db.series.find((x) => x.id === e.target.dataset.cover); if (s) wantCover(s); io.unobserve(e.target); } });
}, { rootMargin: "200px" }) : null;

// ---------- recherche dans les bases ----------
// Google Books (clé gratuite de l'utilisateur, sinon quota partagé souvent épuisé), BnF (ISBN et titres exacts des
// albums déposés en France), Open Library (secours). Rien n'est envoyé d'autre que le texte cherché.
const GB_KEY = "gestio.gbkey";
const gbKey = () => { try { return localStorage.getItem(GB_KEY) || ""; } catch { return ""; } };
let gbPausedUntil = 0; // après un « quota atteint », on laisse Google tranquille 10 minutes
let lastSearchError = "";
const https = (u) => (u ? u.replace(/^http:/, "https:").replace("&edge=curl", "") : null);
async function googleBooks(q, max) {
  if (Date.now() < gbPausedUntil) throw new Error("google quota");
  const key = gbKey();
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=${max}&printType=books${key ? `&key=${encodeURIComponent(key)}` : ""}`;
  const r = await fetch(url);
  if (r.status === 429 || r.status === 403) { gbPausedUntil = Date.now() + 10 * 60e3; lastSearchError = key ? "quota" : "quota-nokey"; }
  if (!r.ok) throw new Error("google " + r.status);
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
// Catalogue général de la BnF (SRU, Dublin Core). Donne le titre exact du tome et son ISBN ; pas d'image (droits).
const cql = (s) => String(s).replace(/["\\]/g, " ").trim();
async function bnf(name, num, editeur, max) {
  let q = `bib.title all "${cql(name)}${num != null ? ` ${num}` : ""}"`;
  if (editeur) q += ` and bib.publisher all "${cql(editeur.split(/[ /?]/)[0])}"`;
  const url = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&recordSchema=dublincore&maximumRecords=${max}&query=${encodeURIComponent(q)}`;
  const r = await fetch(url); if (!r.ok) throw new Error("bnf " + r.status);
  return parseBnf(await r.text());
}
function parseBnf(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const all = (el, tag) => [...el.getElementsByTagNameNS("*", tag)].map((x) => x.textContent.trim());
  return [...doc.getElementsByTagNameNS("*", "dc")].map((dc) => {
    const titre = (all(dc, "title")[0] || "").replace(/\s*\/.*$/, "").replace(/\s*\[[^\]]*\]/g, "");
    const isbn = all(dc, "identifier").map((x) => x.match(/ISBN\s*([\dXx-]{10,17})/)?.[1]).find(Boolean)?.replace(/-/g, "") || "";
    const editeur = (all(dc, "publisher")[0] || "").replace(/\s*\(.*$/, "");
    const annee = (all(dc, "date")[0] || "").match(/\d{4}/)?.[0] || "";
    const auteurs = all(dc, "creator").slice(0, 3).map((c) => c.replace(/\s*\(.*$/, "")).join(", ");
    return { source: "BnF", titre, editeur, annee, auteurs, isbn, cover: null };
  }).filter((c) => c.titre);
}
// Couverture d'un ISBN : Google Books (si la clé est là), sinon l'image Open Library par ISBN (vérifiée à l'affichage).
async function coverByIsbn(isbn) {
  if (gbKey()) {
    const hit = (await googleBooks(`isbn:${isbn}`, 1).catch(() => []))[0];
    if (hit?.cover) return hit.cover;
  }
  return `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`;
}
function rank(c, name, num, editeur) {
  let sc = similarity(name, c.titre) * 3;
  if (num != null && new RegExp(`(^|\\D)0*${num}(\\D|$)`).test(c.titre)) sc += 1.5;
  if (editeur && norm(c.editeur).includes(norm(editeur).split(" ")[0])) sc += 0.6;
  if (c.cover) sc += 0.4;
  if (c.isbn) sc += 0.2;
  return sc;
}
async function searchBases(name, num, editeur, max = 6, query) {
  const q = query || (num != null ? `${name} ${num}` : name);
  const olq = num != null ? `${name} ${num}` : name; // la syntaxe intitle:/inpublisher: n'existe que chez Google
  lastSearchError = "";
  const res = await Promise.allSettled([googleBooks(q, 8), bnf(name, num, editeur, 8), openLibrary(olq, 6)]);
  if (res.every((r) => r.status === "rejected")) { if (!lastSearchError) lastSearchError = navigator.onLine ? "bases" : "offline"; throw new Error(lastSearchError); }
  const all = res.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const seen = new Set();
  const ranked = all.filter((c) => { const k = c.isbn || norm(c.titre + c.editeur); if (seen.has(k)) return false; seen.add(k); return true; })
    .map((c) => ({ ...c, score: rank(c, name, num, editeur) })).sort((a, b) => b.score - a.score).slice(0, max);
  // Les meilleures fiches BnF n'ont pas d'image : on la cherche par ISBN.
  await Promise.all(ranked.slice(0, 3).filter((c) => !c.cover && c.isbn).map(async (c) => { c.cover = await coverByIsbn(c.isbn); c.score += 0.4; }));
  return ranked.sort((a, b) => b.score - a.score);
}

// ---------- rendu ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let filterM = "Tout", filterC = "Tout";

function chips(el, current, onPick) {
  el.innerHTML = ["Tout", ...GENRES.map((g) => g.id)].map((g) =>
    `<button type="button" class="chip" data-g="${esc(g)}" aria-pressed="${g === current}">${g === "Tout" ? "" : `<svg class="ico"><use href="#${genreIcon(g)}"/></svg>`}${esc(g)}</button>`).join("");
  el.onclick = (e) => { const b = e.target.closest(".chip"); if (b) onPick(b.dataset.g); };
}
function serieRow(s, extra, count) {
  return `<button class="serie" data-id="${esc(s.id)}">
    <span class="cover" data-cover="${esc(s.id)}"></span>
    <span class="meta"><span class="name">${esc(s.titre)}</span>
      <span class="sub">${esc([s.editeur, s.collection].filter(Boolean).join(" · "))}${s.aConfirmer ? ` <span class="flag">· à confirmer</span>` : ""}</span>
      ${extra || ""}</span>
    <span class="count">${esc(count ?? `${(s.possedes || []).length} vol.`)}</span></button>`;
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
  const empty = !db.series.length;
  $("#welcome").hidden = !empty; $("#v-manques").classList.toggle("is-empty", empty);
  chips($("#chips-manques"), filterM, (g) => { filterM = g; renderManques(); });
  $("#sort-manques").innerHTML = [["az", "A à Z"], ["near", "Presque complètes"]].map(([k, l]) =>
    `<button type="button" class="chip" data-sort="${k}" aria-pressed="${k === sortM}">${l}</button>`).join("");
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
    : `<p class="empty">${hits ? "Aucun manque dans les séries qui correspondent à ta recherche." : "Aucun trou dans tes séries pour ce filtre."}</p>`;
  hydrateCovers($("#v-manques"));
}

function renderAnswer() {
  const q = $("#q").value.trim(); const box = $("#answer");
  if (!q) { box.hidden = true; $("#q-clear").hidden = true; return; }
  const p = parseLine(q);
  // Toutes les séries qui ressemblent autant que la meilleure (« Conan 12 » -> Super Conan, Conan Lug, Cimmérien…)
  // avec un numéro, on ignore les intégrales et les livres isolés (« Nos années Strange » pour « Strange 74 »)
  const all = bestSeries(p.name, 10).filter((r) => p.num == null || (!["integrale", "livre", "roman"].includes(r.s.type) && numeric(r.s.possedes).length));
  const found = all.filter((r) => r.score >= all[0]?.score - 0.12).slice(0, 6);
  box.hidden = false;
  $("#q-clear").hidden = false;
  const addUnknown = `<button type="button" class="btn primary" data-addnew="${esc(q)}">Je l'achète : l'ajouter</button>`;
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
  // Les OUI d'abord ; « + Acheté » reste discret pour éviter un ajout par erreur de doigt.
  const rows = found.map(({ s }) => ({ s, ok: has(s, p.num) })).sort((a, b) => b.ok - a.ok);
  const nOk = rows.filter((r) => r.ok).length;
  box.innerHTML = (rows.length > 1 ? `<span class="v-sum">Tu l'as dans ${nOk} série${nOk > 1 ? "s" : ""} sur ${rows.length}</span>` : "") +
    rows.map(({ s, ok }) => `<div class="verdict-row ${ok ? "have" : "miss"}">
      <span class="v-big">${ok ? "OUI" : "NON"}</span>
      <button type="button" class="v-name" data-open="${esc(s.id)}">${esc(s.titre)} · ${esc(numLabel(s, p.num))}</button>
      ${ok ? "" : `<button type="button" class="btn small" data-addnow="${esc(s.id)}" data-num="${esc(p.num)}">+ Acheté</button>`}
    </div>`).join("") +
    `<button type="button" class="linkish" data-addnew="${esc(q)}">C'est une autre série : l'ajouter</button>`;
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
let wishMode = false, editOpen = false;
function openSerie(id) {
  const s = db.series.find((x) => x.id === id); if (!s) return;
  const dlg = $("#detail");
  const nums = numeric(s.possedes);
  const wish = new Set((s.souhaits || []).map(String));
  const max = Math.max(s.parus || 0, ...nums, ...[...wish].filter((x) => /^\d+$/.test(x)).map(Number), 0);
  const start = nums.includes(0) ? 0 : 1;
  const grid = [];
  for (let i = start; i <= max; i++) {
    const st = has(s, i) ? "have" : wish.has(String(i)) ? "wish" : "miss";
    const titre = s.titres?.[i] ? ` – ${s.titres[i]}` : "";
    grid.push(`<button type="button" class="tome ${st}" data-n="${i}" title="Tome ${i}${esc(titre)}" aria-label="${esc(numLabel(s, i))}${esc(titre)} : ${st === "have" ? "je l'ai" : st === "wish" ? "souhaité" : "manquant"}">${i}</button>`);
  }
  grid.push(`<button type="button" class="tome next" data-n="${max + 1}" aria-label="J'ai aussi le ${esc(numLabel(s, max + 1))}">+</button>`);
  const others = (s.possedes || []).filter((x) => !/^\d+$/.test(String(x)));
  dlg.innerHTML = `<div class="sheet-inner">
    <div class="grab" aria-hidden="true"></div>
    <h2>${esc(s.titre)}</h2>
    <div class="row" style="justify-content:flex-start;align-items:flex-start">
      <span class="cover" data-cover="${esc(s.id)}" style="width:72px;height:98px"></span>
      <div class="meta"><div>${esc(s.auteurs || "")}</div><div class="hint">${esc([s.editeur, s.collection].filter(Boolean).join(" · "))}</div>
      ${s.note ? `<div class="hint">${esc(s.note)}</div>` : ""}</div></div>
    ${s.type !== "integrale" ? `<div class="legend"><span class="lg have">Je l'ai</span><span class="lg miss">Manque</span><span class="lg wish">Souhait</span><span class="lg next">+ tome suivant</span></div>
    <div class="row wrap-row"><span class="hint">${wishMode ? "Touche un numéro pour le mettre ou l'enlever de tes souhaits." : "Touche un numéro : je l'ai / je ne l'ai pas."}</span>
      <button type="button" class="btn small${wishMode ? " primary" : ""}" data-wishmode aria-pressed="${wishMode}"><svg class="ico"><use href="#i-star"/></svg>Souhaits</button></div>
    <div class="tomes">${grid.join("")}</div>` : ""}
    ${others.length ? `<div><div class="hint">Autres volumes</div><div class="extra">${others.map((o) => `<span class="tome have">${esc(o)}</span>`).join("")}</div></div>` : ""}
    ${detailList(s)}
    <details class="edit"${editOpen ? " open" : ""}><summary>Modifier la série</summary>
    <div class="grid2">
      <label class="field">Tomes parus (pour voir les manques au-delà)<input id="f-parus" type="number" min="0" inputmode="numeric" value="${esc(s.parus || "")}"></label>
      <label class="field">Éditeur<input id="f-editeur" value="${esc(s.editeur)}"></label>
      <label class="field">Collection<input id="f-collection" value="${esc(s.collection)}"></label>
      <label class="field">Genre<select id="f-genre" class="field-select">${GENRES.map((g) => `<option${g.id === s.genre ? " selected" : ""}>${g.id}</option>`).join("")}</select></label>
    </div>
    <p class="hint">Les changements sont enregistrés dès que tu quittes le champ.</p>
    <div class="row wrap-row">
      <button type="button" class="btn" data-recover>Chercher une couverture</button>
      <label class="btn">Photographier la couverture<input id="f-photo" type="file" accept="image/*" capture="environment" hidden></label>
    </div>
    <div data-covers></div>
    <div class="danger-zone">
      <button type="button" class="btn danger" data-del>Supprimer la série</button>
      <div class="row wrap-row" data-delconfirm hidden><span>Supprimer « ${esc(s.titre)} » ?</span><button type="button" class="btn danger small" data-delyes>Oui</button><button type="button" class="btn small" data-delno>Non</button></div>
    </div>
    </details>
    <div class="sheet-bar"><button type="button" class="btn wide" data-close>Fermer</button></div>
  </div>`;
  dlg.querySelector("details.edit").addEventListener("toggle", (e) => (editOpen = e.target.open));
  hydrateCovers(dlg);
  // Chaque champ est enregistré dès qu'on le quitte : rien ne se perd si on touche un tome ensuite.
  const meta = () => {
    s.parus = Number($("#f-parus").value) || null; s.editeur = $("#f-editeur").value.trim();
    s.collection = $("#f-collection").value.trim(); s.genre = $("#f-genre").value; save(KEY, db); renderAll();
  };
  dlg.querySelectorAll("#f-parus, #f-editeur, #f-collection, #f-genre").forEach((el) => (el.onchange = meta));
  dlg.onclose = () => { wishMode = false; editOpen = false; };
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
    if (t.closest("[data-del]")) { dlg.querySelector("[data-delconfirm]").hidden = false; return; }
    if (t.closest("[data-delno]")) { dlg.querySelector("[data-delconfirm]").hidden = true; return; }
    if (t.closest("[data-delyes]")) { db.series = db.series.filter((x) => x.id !== s.id); persist(); dlg.close(); return toast("Série supprimée"); }
    if (t.closest("[data-recover]")) {
      const box = dlg.querySelector("[data-covers]"); box.innerHTML = `<p class="hint">Recherche…</p>`;
      try {
        const cands = (await searchBases(s.titre, numeric(s.possedes)[0] ?? null, s.editeur, 10)).filter((c) => c.cover);
        box.innerHTML = cands.length ? `<div class="cands">${cands.map((c, i) => candHtml(c, i)).join("")}</div>` : `<p class="hint">Aucune couverture trouvée.</p>`;
        fixImgs(box);
        box.querySelector(".cands")?.addEventListener("click", (ev) => {
          const b = ev.target.closest(".cand"); if (!b) return;
          s.cover = cands[Number(b.dataset.i)].cover; persist(); openSerie(s.id);
        });
      } catch { box.innerHTML = `<p class="hint">${esc(searchErrorText())}</p>`; }
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
// Message clair selon la panne : pas de réseau, quota Google, ou bases muettes.
function searchErrorText() {
  if (lastSearchError === "offline" || !navigator.onLine) return "Pas de réseau pour l'instant. Réessaie quand tu en auras.";
  if (lastSearchError === "quota-nokey") return "Google Books a atteint son quota du jour. Ajoute ta clé gratuite dans Réglages > Couvertures.";
  if (lastSearchError === "quota") return "Ta clé Google Books a atteint son quota du jour. Réessaie demain.";
  return "Les bases n'ont pas répondu. Réessaie dans un moment.";
}
// Une image qui ne charge pas (couverture absente chez Open Library…) laisse place au picto.
function fixImgs(root) {
  root.querySelectorAll(".cimg img").forEach((img) => (img.onerror = () => { img.parentElement.innerHTML = `<svg class="ico"><use href="#i-book"/></svg>`; }));
}
function candHtml(c, i) {
  return `<button type="button" class="cand${i === 0 ? " best" : ""}" data-i="${i}">
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
    block.querySelector(".hint").remove();
    const wrap = document.createElement("div"); block.append(wrap);
    let cands = [];
    const look = async () => {
      wrap.innerHTML = `<p class="hint">Recherche dans les bases…</p><div class="cands" aria-busy="true">${'<span class="cand skel"></span>'.repeat(3)}</div>`;
      let err = "";
      try { cands = await searchBases(p.name, p.num, sure?.editeur, 6); } // toujours avec le texte saisi
      catch { cands = []; err = searchErrorText(); }
      wrap.innerHTML = `${cands.length ? `<p class="hint">Choisis la bonne édition (la première est la plus probable) :</p><div class="cands">${cands.map((c, i) => candHtml(c, i)).join("")}</div>`
        : err ? `<p class="warn">${esc(err)}</p>` : `<p class="hint">Aucune édition trouvée dans les bases. Tu peux l'ajouter quand même.</p>`}
        <div class="row wrap-row">${err ? `<button type="button" class="btn small" data-retry>Réessayer</button>` : ""}<button type="button" class="btn small" data-plain>Ajouter sans édition précise</button></div>`;
      fixImgs(wrap);
    };
    await look();
    const done = (s) => { wrap.innerHTML = `<p class="done">${wish ? "Ajouté aux souhaits" : "Ajouté"} : ${esc(s.titre)}${p.num != null ? ` ${esc(numLabel(s, p.num))}` : ""}</p>`; };
    wrap.onclick = (e) => {
      if (e.target.closest("[data-retry]")) return look();
      const b = e.target.closest(".cand:not(.skel)"); const plain = e.target.closest("[data-plain]");
      if (!b && !plain) return;
      const genre = block.querySelector("[data-genre]")?.value;
      if (tsel) tsel.disabled = true;
      done(addVolume({ serieId: tsel?.value || null, newName: p.name, genre, num: p.num, cand: b ? cands[Number(b.dataset.i)] : null, wish }));
    };
    await new Promise((r) => setTimeout(r, 400)); // une ligne après l'autre, pour ménager les quotas des bases
  }
}

// dictée vocale du navigateur (Chrome Android, Edge, Safari récent)
// La reconnaissance passe par les serveurs de Google (Chrome) : il faut internet et l'accès au micro.
const SR = window.webkitSpeechRecognition || window.SpeechRecognition; // la version préfixée est la plus éprouvée sur Chrome
const MIC_ERR = {
  "not-allowed": "Le micro est refusé. Touche le cadenas à gauche de l'adresse, puis Autorisations > Micro > Autoriser. Si l'appli est installée : Paramètres Android > Applis > Chrome > Autorisations > Micro.",
  "service-not-allowed": "Ce navigateur bloque la dictée. Ouvre l'appli dans Chrome, ou utilise le micro de ton clavier.",
  "audio-capture": "Le micro ne répond pas (une autre appli l'utilise peut-être). Réessaie, ou utilise le micro de ton clavier.",
  "network": "La dictée a besoin d'internet. Sans réseau, utilise le micro de ton clavier.",
  "no-speech": "Je n'ai rien entendu. Touche le micro, attends qu'il devienne rouge, puis parle.",
  "language-not-supported": "Le français n'est pas disponible pour la dictée sur ce téléphone. Utilise le micro de ton clavier.",
};
let rec = null;
function keyboardMic(msg) {
  toast(msg);
  const ta = $("#saisie"); ta.focus(); // fait apparaître le clavier, et donc son micro
}
$("#mic").addEventListener("click", () => {
  if (rec) { try { rec.stop(); } catch { /* déjà arrêtée */ } return; }
  if (!SR) return keyboardMic("Dictée non disponible dans ce navigateur : utilise le micro de ton clavier (ou ouvre l'appli dans Chrome).");
  if (navigator.onLine === false) return keyboardMic(MIC_ERR.network);
  const ta = $("#saisie"), mic = $("#mic");
  const base = ta.value.trim() ? ta.value.trim() + "\n" : "";
  let heard = false, failed = false, started = false;
  const r = new SR();
  r.lang = "fr-FR"; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
  mic.classList.add("live");
  r.onstart = () => { started = true; toast("Je t'écoute… parle maintenant."); };
  // Si rien ne démarre (micro bloqué sans message, service indisponible), on ne reste pas bloqué.
  const watchdog = setTimeout(() => { if (!started && rec === r) { failed = true; try { r.abort(); } catch { /* rien */ } rec = null; mic.classList.remove("live");
    keyboardMic("La dictée ne démarre pas sur ce téléphone. Utilise le micro de ton clavier."); } }, 5000);
  r.onresult = (e) => {
    // On recalcule tout le texte à chaque fois : Chrome Android répète parfois des morceaux sinon.
    const said = Array.from(e.results).map((x) => x[0].transcript).join(" ").replace(/\s+/g, " ").trim();
    if (said) { heard = true; ta.value = base + said; }
  };
  r.onerror = (e) => {
    if (e.error === "aborted") return;
    failed = true;
    const msg = MIC_ERR[e.error] || `La dictée s'est arrêtée (${e.error || "erreur inconnue"}). Tu peux utiliser le micro de ton clavier.`;
    if (["not-allowed", "service-not-allowed", "network", "language-not-supported"].includes(e.error)) keyboardMic(msg); else toast(msg);
  };
  r.onend = () => {
    clearTimeout(watchdog);
    if (rec !== r) return;
    mic.classList.remove("live"); rec = null;
    if (!heard && !failed) toast(MIC_ERR["no-speech"]);
    else if (heard) { $("#toast").hidden = true; ta.scrollTop = ta.scrollHeight; }
  };
  rec = r;
  try { r.start(); }
  catch { clearTimeout(watchdog); rec = null; mic.classList.remove("live"); keyboardMic("La dictée n'a pas pu démarrer. Utilise le micro de ton clavier."); }
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
    toast(`Import terminé : ${db.series.length} séries dans ta collection.`);
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
  document.querySelectorAll(".tab").forEach((t) => { t.classList.toggle("on", t.dataset.v === v); if (t.dataset.v === v) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current"); });
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
  const go = e.target.closest("[data-go]");
  if (go) return show(go.dataset.go);
  const addNew = e.target.closest("[data-addnew]");
  if (addNew) { $("#saisie").value = addNew.dataset.addnew; $("#as-wish").checked = false; show("ajouter"); return runSearch(); }
  const open = e.target.closest("[data-open], .serie");
  if (open) openSerie(open.dataset.open || open.dataset.id);
});
$("#q").addEventListener("input", () => { renderAnswer(); renderManques(); });
$("#q-clear").addEventListener("click", () => { $("#q").value = ""; renderAnswer(); renderManques(); $("#q").focus(); });
// clé Google Books
$("#gbkey").value = gbKey();
$("#gbkey-save").addEventListener("click", async () => {
  const k = $("#gbkey").value.trim(); const msg = $("#gbkey-msg");
  try { if (k) localStorage.setItem(GB_KEY, k); else localStorage.removeItem(GB_KEY); } catch { msg.textContent = "Impossible d'enregistrer sur cet appareil."; return; }
  if (!k) { msg.textContent = "Clé retirée."; return; }
  msg.textContent = "Vérification…"; gbPausedUntil = 0;
  try {
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=lanfeust&maxResults=1&key=${encodeURIComponent(k)}`);
    msg.textContent = r.ok ? "Clé enregistrée et vérifiée." : r.status === 400 ? "Clé refusée : vérifie qu'elle est bien copiée." :
      r.status === 403 ? "Clé refusée : active « Books API » et vérifie les restrictions." : `Clé enregistrée (réponse ${r.status}).`;
    if (r.ok) { for (const id in covers) if (String(covers[id]).startsWith("none")) delete covers[id]; save(COVERS_KEY, covers); renderAll(); }
  } catch { msg.textContent = "Clé enregistrée. Pas de réseau pour la vérifier."; }
});
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
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), undo ? 6000 : Math.max(2600, msg.length * 70)); // les longs messages restent le temps de les lire
}

const start = (location.hash || "").slice(1);
const first = VIEWS.includes(start) ? start : "manques";
history.replaceState(null, "", "#" + first); show(first);
renderAll();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// pour les tests
window.__gestio = { parseLine, similarity, missingOf, bestSeries, mergeImport, shareText };
