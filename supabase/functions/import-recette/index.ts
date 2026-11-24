// Fonction Supabase (Edge Function). Lit la fiche recette cachée dans une page web (format schema.org/Recipe)
// et copie ses photos dans le stockage du carnet. Réservé aux personnes connectées.

const SB_URL = "https://vshxudfhstondwcdpdxs.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZzaHh1ZGZoc3RvbmR3Y2RwZHhzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5NzczMzMsImV4cCI6MjEwNzU1MzMzM30.0ockwakfigfeghTQoJr_PxSkHsCuAqOyFvSx6EKbUO0";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const MAX_PHOTOS = 4, MAX_IMG = 6 * 1024 * 1024;

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, apikey, content-type, x-client-info", "access-control-allow-methods": "GET, OPTIONS" };
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  // 1. Personne connectée ?
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return json(401, { erreur: "Connectez-vous pour importer une recette." });
  const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, authorization: auth } });
  if (!u.ok) return json(401, { erreur: "Votre connexion a expiré. Reconnectez-vous." });
  const user = await u.json();

  // 2. Lien valide ?
  const lien = new URL(req.url).searchParams.get("url") || "";
  let cible;
  try { cible = new URL(lien.trim()); } catch { return json(400, { erreur: "Ce lien n'est pas valide." }); }
  if (!/^https?:$/.test(cible.protocol) || interdit(cible.hostname)) return json(400, { erreur: "Ce lien n'est pas valide." });

  // 3. Lecture de la page
  let html;
  try {
    const r = await fetch(cible, { redirect: "follow", signal: AbortSignal.timeout(12000),
      headers: { "user-agent": UA, "accept": "text/html,application/xhtml+xml", "accept-language": "fr-FR,fr;q=0.9" } });
    if (!r.ok) return json(502, { erreur: `Le site a refusé la lecture (code ${r.status}). Utilisez le copier-coller.` });
    html = (await r.text()).slice(0, 3_000_000);
  } catch {
    return json(504, { erreur: "Le site ne répond pas. Réessayez, ou utilisez le copier-coller." });
  }

  // 4. Fiche recette
  const rec = trouverRecette(html);
  if (!rec) return json(422, { erreur: "Pas de fiche recette lisible sur cette page. Utilisez le copier-coller." });
  const res = {
    source: cible.href,
    titre: texte(rec.name) || meta(html, "og:title") || "",
    personnes: entier(Array.isArray(rec.recipeYield) ? rec.recipeYield[0] : rec.recipeYield),
    prep: minutes(rec.prepTime), cuisson: minutes(rec.cookTime), total: minutes(rec.totalTime),
    categorie: texte(Array.isArray(rec.recipeCategory) ? rec.recipeCategory[0] : rec.recipeCategory),
    ingredients: (Array.isArray(rec.recipeIngredient) ? rec.recipeIngredient : rec.ingredients || []).map(texte).filter(Boolean),
    etapes: etapes(rec.recipeInstructions),
    photos: []
  };

  // 5. Photos copiées dans le carnet (dossier de la personne)
  let liste = images(rec.image); if (!liste.length) liste = [meta(html, "og:image")];
  const urls = [...new Set(liste.filter(Boolean))].slice(0, MAX_PHOTOS);
  for (let i = 0; i < urls.length; i++) {
    try {
      const img = await fetch(new URL(urls[i], cible), { headers: { "user-agent": UA, referer: cible.origin }, signal: AbortSignal.timeout(10000) });
      const type = (img.headers.get("content-type") || "").split(";")[0];
      if (!img.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type)) continue;
      const buf = await img.arrayBuffer();
      if (buf.byteLength > MAX_IMG || buf.byteLength < 2000) continue;
      const ext = type.split("/")[1].replace("jpeg", "jpg");
      const chemin = `${user.id}/import-${Date.now().toString(36)}-${i}.${ext}`;
      const up = await fetch(`${SB_URL}/storage/v1/object/photos/${chemin}`, {
        method: "POST", body: buf, headers: { apikey: SB_KEY, authorization: auth, "content-type": type, "x-upsert": "false" } });
      if (up.ok) res.photos.push(`${SB_URL}/storage/v1/object/public/photos/${chemin}`);
    } catch { /* photo ignorée */ }
  }
  return json(200, res);
});

/* ---------- outils ---------- */
function interdit(h) {
  h = h.toLowerCase();
  return h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^\[|^(127|10|0)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(h);
}
function decode(s) {
  return String(s).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function texte(v) {
  if (v == null) return "";
  if (typeof v === "object") v = v.text || v.name || "";
  return decode(String(v).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function entier(v) { const m = String(v ?? "").match(/\d+/); return m ? +m[0] : null; }
function minutes(iso) {
  if (!iso) return null;
  const m = String(iso).match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/i);
  if (!m) return null;
  const t = (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0);
  return t || null;
}
function etapes(v) {
  const out = [];
  const visit = (x) => {
    if (!x) return;
    if (typeof x === "string") { x.split(/\n+/).map(texte).filter(Boolean).forEach(s => out.push(s)); return; }
    if (Array.isArray(x)) { x.forEach(visit); return; }
    if (x.itemListElement) { visit(x.itemListElement); return; }
    const t = texte(x.text || x.name);
    if (t) out.push(t);
  };
  visit(v);
  return out;
}
function images(v) {
  if (!v) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(images);
  return [v.url || v.contentUrl].filter(Boolean);
}
function meta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, "i");
  const m = html.match(re);
  return m ? decode(m[1] || m[2]) : "";
}
function estRecette(o) {
  const t = o && o["@type"];
  return t && (t === "Recipe" || (Array.isArray(t) && t.includes("Recipe")));
}
function chercher(o) {
  if (!o || typeof o !== "object") return null;
  if (estRecette(o)) return o;
  const enfants = Array.isArray(o) ? o : [o["@graph"], o.mainEntity, o.itemListElement].filter(Boolean);
  for (const e of enfants.flat ? enfants.flat() : enfants) { const r = chercher(e); if (r) return r; }
  return null;
}
function trouverRecette(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { const r = chercher(JSON.parse(m[1].trim())); if (r) return r; } catch { /* bloc illisible */ }
  }
  return null;
}
