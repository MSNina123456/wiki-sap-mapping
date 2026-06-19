#!/usr/bin/env node
// wiki-sap.mjs — unified pipeline orchestrator for the Wiki ↔ SAP mapping.
//
// Single-file replacement for the ten ad-hoc scripts that lived under
// scripts/ in earlier iterations. Each pipeline step is a subcommand:
//
//   node wiki-sap.mjs <command>
//
//   validate-catalog      hard-fail on schema / dup / bad-override drift
//   list-wiki-pages       walk wikiRoot, emit out/wiki-pages.json + catalog-hash.txt
//   diff-pages            cache vs current → wiki-pages-changed + carryover + summary
//   prepare-l1-route      compact L1 catalog + Stage-1 input
//   prepare-l2l3-detail   bucket pages by Stage-1 L1, batch, drop no-matches
//   consolidate-stage2    merge all per-batch agent outputs + overrides
//   merge-mapping         carryover + changed → final mapping (in page order)
//   render-per-l1         one detail page per L1 (folder-fold + "More" details)
//   render-index          top-level INDEX page (reads render-stats from render-per-l1)
//   publish-mapping       sync rendered md into AAAP_CodeWiki/Draft/Nina/ for Agency to commit
//
// Tunable env vars:
//   WIKI_ROOT                 default: <cwd>/AAAP_CodeWiki
//   WIKI_CONTENT_CHAR_LIMIT   default: 8000  (per-page truncation for prompts)
//   STAGE1_EXCERPT_CHARS      default: 1500  (Stage 1 excerpt size)
//   MAX_PAGES_PER_BUCKET_BATCH default: 50   (Stage 2 batch cap)
//   PER_LEAF_CAP              default: 20    (max wiki pages per leaf SAP)
//   VISIBLE_PER_LEAF          default: 5     (rows shown before "More" fold)
//   MIN_LEAF_SCORE_AI         default: 0.55  (Rule C strict-filter threshold for ai source)
//   KEYWORD_TOKEN_RATIO       default: 0.66  (Rule C — fraction of significant tokens in a multi-word keyword that must hit)
//   AI_CAP_NO_TITLE_HIT       default: 0.50  (Score cap when 0 leaf tokens appear in page title)
//   AI_CAP_ONE_TITLE_HIT      default: 0.70  (Score cap when 1 leaf token appears in page title; ≥2 → no cap)
//   TITLE_MATCH_SCORE         default: 0.90  (score given to L3-title-match cross-leaf injections)
//   FALLBACK_MAX              default: 2     (top-N by score kept if 0 pages pass Rule C)
//
// Exit codes (aligned with agent.md results: block):
//   0  ok          5  no-changes        11 stage1-failed
//   12 stage2-partial               13 catalog-invalid

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// ────────────────────────────────────────────────────────────────────────────
// Paths and inline config (formerly wiki-source.json)
// ────────────────────────────────────────────────────────────────────────────
const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.resolve(__dirname, "config");
const SAP_FILE   = path.join(CONFIG_DIR, "sap-catalog.json");
const OVR_FILE   = path.join(CONFIG_DIR, "wiki-sap-overrides.json");
const OUT_DIR    = path.resolve(process.cwd(), "out");

// Where the published mapping lives in the AAAP code wiki tree.
//   Filesystem layout (under repo root):
//     AAAP_CodeWiki/Draft/Nina/Wiki-SAP-Mapping.md            ← INDEX page
//     AAAP_CodeWiki/Draft/Nina/Wiki-SAP-Mapping/<L1>.md       ← per-L1 detail
//   Wiki URL layout (what readers click):
//     /Draft/Nina/Wiki-SAP-Mapping
//     /Draft/Nina/Wiki-SAP-Mapping/Wiki-SAP-Mapping-<slug>
// Publish location is centrally configured by the pipeline YAML
// (`variables:` block in wiki-sap-mapping-pipeline.yml). The 3 constants
// below read those pipeline variables via env vars at runtime; the
// hardcoded fallbacks are used when running the script locally outside
// the pipeline.
const PUBLISH_PARENT_DIR = process.env.PUBLISH_PARENT_DIR
  || path.posix.join("AAAP_CodeWiki", "Draft", "Nina");
const INDEX_PAGE_NAME    = process.env.INDEX_PAGE_NAME    || "Wiki-SAP-Mapping";
const WIKI_URL_PREFIX    = process.env.WIKI_URL_PREFIX    || "/Draft/Nina";

const WIKI_CFG = {
  wikiRoot: "AAAP_CodeWiki",
  excludedDirs: [
    // Draft is excluded from list-wiki-pages because our own published
    // output lives under AAAP_CodeWiki/Draft/Nina/. Without this exclusion
    // we'd self-classify our own mapping pages on every run.
    "Draft", ".attachments", "Archived",
    ".git", ".pipelines", ".config", ".azuredevops", ".github",
    "out", "node_modules", "wiki-sap-mapping"
  ]
};

const CONST = {
  CHAR_LIMIT:       parseInt(process.env.WIKI_CONTENT_CHAR_LIMIT  || "8000", 10),
  STAGE1_EXCERPT:   parseInt(process.env.STAGE1_EXCERPT_CHARS     || "1500", 10),
  BATCH_SIZE:  Math.max(1, parseInt(process.env.MAX_PAGES_PER_BUCKET_BATCH || "50", 10)),
  PER_LEAF_CAP:     parseInt(process.env.PER_LEAF_CAP             || "20", 10),
  VISIBLE_PER_LEAF: parseInt(process.env.VISIBLE_PER_LEAF         || "5",  10),
  // Strict filter for AI-classified assignments (Rule C):
  //   keep iff source∈{override,rule} OR (score≥MIN AND ≥1 leaf keyword
  //   matches in page title/path/content). Multi-word keywords match if
  //   ≥ ceil(N * KEYWORD_TOKEN_RATIO) of their significant tokens appear
  //   as whole words (not requiring contiguous adjacency). Single-word
  //   keywords still require an exact \b…\b whole-word match. Fallback
  //   when 0 pages pass for a leaf: keep the top FALLBACK_MAX by score
  //   so the leaf isn't empty.
  MIN_LEAF_SCORE_AI:    parseFloat(process.env.MIN_LEAF_SCORE_AI    || "0.55"),
  KEYWORD_TOKEN_RATIO:  parseFloat(process.env.KEYWORD_TOKEN_RATIO  || "0.66"),
  KEYWORD_MIN_TOKEN_LEN: 3,
  // Code-enforced anchor cap on AI-source composite score. Counts how
  // many significant tokens from the leaf's L3 + keywords appear as
  // whole words in the page's title/path (NOT body — body matches are
  // too noisy to evidence real topical alignment).
  AI_CAP_NO_TITLE_HIT:  parseFloat(process.env.AI_CAP_NO_TITLE_HIT  || "0.55"),
  AI_CAP_ONE_TITLE_HIT: parseFloat(process.env.AI_CAP_ONE_TITLE_HIT || "0.70"),
  // Score given to title-match injections (a page whose title contains
  // the leaf's full L3 phrase, singular/plural-tolerant on the last
  // token, even though Stage 2 assigned it to a different leaf).
  TITLE_MATCH_SCORE:    parseFloat(process.env.TITLE_MATCH_SCORE    || "0.90"),
  FALLBACK_MAX:         parseInt(process.env.FALLBACK_MAX           || "2",   10),
  GENERAL: "(General)"
};

// Small stopword list used when tokenising multi-word keyword phrases.
// Lowercase. Kept minimal — only the words that are almost never
// content-bearing and whose presence/absence in a page is noise.
const KW_STOPWORDS = new Set([
  "the","and","for","with","from","that","this","your","not","are","was","were",
  "has","have","had","can","its","of","in","on","at","to","a","an","or","by","is",
  "be","as","it"
]);

// ────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────────────────────
const exists    = async p => { try { await fs.access(p); return true; } catch { return false; } };
const loadJson  = async (p, fb) => { try { return JSON.parse(await fs.readFile(p, "utf8")); }
                                     catch (e) { if (e.code === "ENOENT" && fb !== undefined) return fb; throw e; } };
const loadText  = async p => (await fs.readFile(p, "utf8")).trim();
const writeJson = (p, v) => fs.writeFile(p, JSON.stringify(v, null, 2), "utf8");
const sha256    = s => crypto.createHash("sha256").update(s).digest("hex");
const pad3      = n => String(n).padStart(3, "0");
const slug      = s => s.replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "");
const chunk     = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const esc       = s => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const escapeRegex = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ────────────────────────────────────────────────────────────────────────────
// Title decoding for ADO Code Wiki filenames
// ────────────────────────────────────────────────────────────────────────────
// ADO Code Wiki encodes special chars in page filenames as %XX. Hyphens in
// the original title are stored as %2D so that they survive ADO's display
// convention of replacing - with space. We:
//   1. preserve original hyphens through the - → space dance
//   2. then decodeURIComponent the rest (%3A → ':', %26 → '&', %5B → '[', …)
// so "HT%3A-See-azcmagent-installation-info-on-RedHat" displays as
// "HT: See azcmagent installation info on RedHat".
function decodeWikiTitle(stem) {
  const PLACE = "\u0000";
  let s = stem
    .replace(/%2D/gi, PLACE)
    .replace(/-/g, " ")
    .replace(new RegExp(PLACE, "g"), "-");
  try { s = decodeURIComponent(s); } catch { /* malformed escape — keep partial */ }
  return s;
}

// Re-derive the display title from the wikiPath so the link text reflects
// the current decoder (carryover entries in cache may have a title that
// was computed by an older decoder version — re-deriving avoids drift).
function titleFromWikiPath(wikiPath) {
  const stem = String(wikiPath || "").split("/").filter(Boolean).pop() || "";
  return decodeWikiTitle(stem);
}

// Render display text safely as the [link text] half of a Markdown link
// living inside a Markdown table cell. Escapes:
//   - backslash  (to keep our own escapes from being doubled)
//   - pipe       (table-cell delimiter)
//   - [ and ]    (could break [...](...) parsing if the decoded title
//                 contains a literal bracket from e.g. %5B / %5D)
//   - newlines   (collapsed to space)
function mdLinkText(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\r?\n/g, " ");
}

// Tokenise a keyword / L3 phrase into "significant" tokens
//   - lowercased
//   - split on whitespace, underscore, hyphen, slash
//   - drop tokens shorter than KEYWORD_MIN_TOKEN_LEN
//   - drop stopwords
// Used by both Rule C keyword matching (token-threshold) and by
// compositeScore's title-overlap anchor cap.
function kwTokens(phrase) {
  return String(phrase || "").toLowerCase()
    .split(/[\s_\-/]+/)
    .filter(t => t.length >= CONST.KEYWORD_MIN_TOKEN_LEN && !KW_STOPWORDS.has(t));
}

// Count how many distinct significant tokens from leafObj (L3 + all
// keywords) appear as \b…\b whole words in the page's TITLE only.
// Body and path are deliberately NOT searched: body matches are too
// noisy (8KB content), and path matches include folder-name noise
// (e.g. ".../Log-Analytics-Agent/MMA-Extension" would otherwise hit
// `agent` from the folder name, even though MMA Extension has nothing
// to do with the Connected Machine agent leaf). Title is the strictest
// curated signal of true topical alignment.
function leafTokenHitsInTitle(e, leafObj) {
  const leafTokSet = new Set();
  for (const kw of leafObj?.keywords || []) for (const t of kwTokens(kw)) leafTokSet.add(t);
  if (leafObj?.l3) for (const t of kwTokens(leafObj.l3)) leafTokSet.add(t);
  if (leafTokSet.size === 0) return 0;
  // Re-derive the title from wikiPath (cache-stale-tolerant), same as
  // wikiLink does for display.
  const title = (e.title && String(e.title).trim()) || titleFromWikiPath(e.wikiPath || "");
  const hay = title.toLowerCase();
  let hits = 0;
  for (const t of leafTokSet) {
    if (new RegExp(`\\b${escapeRegex(t)}\\b`, "i").test(hay)) hits++;
  }
  return hits;
}

// Build a regex that matches the leaf's L3 phrase as a whole-word
// boundary block, tolerating optional trailing 's' on the LAST token
// (so "Dynamic Scopes" matches both "Dynamic Scope" and "Dynamic
// Scopes"). Returns null for missing / "(General)" L3s. Used by the
// title-match injection rule: if a wiki page's title contains the
// full L3 phrase, that page is also listed under that leaf — even
// when Stage 2 classified it elsewhere.
function l3MatchRegex(l3) {
  if (!l3 || l3 === CONST.GENERAL) return null;
  const parts = l3.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const escaped = parts.map(escapeRegex);
  let last = escaped[escaped.length - 1];
  // Make trailing 's' optional regardless of original singular/plural.
  last = /s$/i.test(last) ? last.replace(/s$/i, "s?") : last + "s?";
  escaped[escaped.length - 1] = last;
  return new RegExp(`\\b${escaped.join("\\s+")}\\b`, "i");
}

function titleMatchesL3(e, l3Re) {
  if (!l3Re) return false;
  const title = (e.title && String(e.title).trim()) || titleFromWikiPath(e.wikiPath || "");
  return l3Re.test(title);
}

// Composite "Score" used for ranking + display. Blends model confidence
// with an optional semantic / keyword-overlap score that the agent
// embeds in `reason` text. Source-based modifier: override always 1.00,
// rule-based gets a small bonus (deterministic match), ai uses the blend
// — with an additional anchor cap based on title/path token overlap
// against the leaf (passed as leafObj). Without leafObj, the cap is
// skipped (backwards-compatible). Range [0.00, 1.00], 2-decimal rounded.
function compositeScore(e, leafObj) {
  if (e.source === "override")      return 1.00;
  if (e.source === "title-match")   return CONST.TITLE_MATCH_SCORE;
  if (e.source === "leaf-fallback") return Math.round((Number(e.confidence) || 0.40) * 100) / 100;
  const c = Number(e.confidence) || 0;
  // Try to extract a secondary metric the agent left in reason text.
  const reasonStr = String(e.reason || "");
  let secondary = null;
  const m1 = reasonStr.match(/score\s*[=:]\s*(\d+(?:\.\d+)?)/i);
  if (m1) secondary = Math.min(parseFloat(m1[1]) / 20, 1);   // raw / 20 → 0–1
  const m2 = reasonStr.match(/matched\s+(\d+)\s+terms?/i);
  if (m2) secondary = Math.max(secondary ?? 0, Math.min(parseFloat(m2[1]) / 5, 1));
  const blend = secondary !== null ? (c * 0.7 + secondary * 0.3) : c;
  const bonus = e.source === "rule" ? 0.05 : 0;
  let final = Math.min(blend + bonus, 1.0);

  return Math.round(final * 100) / 100;
}

// Render a wikiPath as a clickable markdown link to the wiki page.
// The title is re-derived from wikiPath via decodeWikiTitle (NOT taken
// from `e.title`, which may be stale from cache). The link target
// (URL) is the wikiPath verbatim — never decoded, since ADO needs the
// %XX form to resolve the page correctly.
function wikiLink(e) {
  return `[${mdLinkText(titleFromWikiPath(e.wikiPath))}](${e.wikiPath})`;
}

// ────────────────────────────────────────────────────────────────────────────
// validate-catalog
// ────────────────────────────────────────────────────────────────────────────
async function cmdValidateCatalog() {
  const errors = [];
  const REQUIRED = ["l1", "l2", "l3", "description", "keywords"];

  let catalog;
  try { catalog = await loadJson(SAP_FILE); }
  catch (e) { console.error(`[validate] sap-catalog.json invalid JSON: ${e.message}`); process.exit(13); }
  if (!Array.isArray(catalog)) { console.error("[validate] sap-catalog.json root must be an array."); process.exit(13); }

  for (let i = 0; i < catalog.length; i++) {
    const leaf = catalog[i];
    if (!leaf || typeof leaf !== "object") { errors.push(`Leaf #${i} not an object.`); continue; }
    for (const k of REQUIRED) if (!(k in leaf)) errors.push(`Leaf #${i} missing field: ${k}`);
    if (typeof leaf.l1 !== "string" || !leaf.l1) errors.push(`Leaf #${i} l1 must be non-empty string.`);
    if (typeof leaf.l2 !== "string" || !leaf.l2) errors.push(`Leaf #${i} l2 must be non-empty string.`);
    if (typeof leaf.l3 !== "string" || !leaf.l3) errors.push(`Leaf #${i} l3 must be non-empty string.`);
    if (typeof leaf.description !== "string") errors.push(`Leaf #${i} description must be string.`);
    if (!Array.isArray(leaf.keywords)) errors.push(`Leaf #${i} keywords must be array.`);
    else for (const kw of leaf.keywords) if (typeof kw !== "string") errors.push(`Leaf #${i} non-string keyword.`);
  }
  if (errors.length) return finish();

  const triples = new Map();
  for (let i = 0; i < catalog.length; i++) {
    const key = `${catalog[i].l1}|${catalog[i].l2}|${catalog[i].l3}`;
    if (triples.has(key)) errors.push(`Duplicate triple #${triples.get(key)} and #${i}: ${key.replace(/\|/g, " > ")}`);
    else triples.set(key, i);
  }

  const kwOwner = new Map();
  for (const leaf of catalog) {
    const tag = `${leaf.l1} > ${leaf.l2} > ${leaf.l3}`;
    for (const kw of leaf.keywords || []) {
      const k = kw.toLowerCase();
      if (kwOwner.has(k)) errors.push(`Keyword ${JSON.stringify(kw)} duplicated: "${kwOwner.get(k)}" AND "${tag}".`);
      else kwOwner.set(k, tag);
    }
  }

  if (await exists(OVR_FILE)) {
    let overrides;
    try { overrides = await loadJson(OVR_FILE); }
    catch (e) { errors.push(`wiki-sap-overrides.json invalid JSON: ${e.message}`); return finish(); }
    if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
      errors.push('wiki-sap-overrides.json must be {wikiPath: "L1 > L2 > L3"} object.');
    } else {
      for (const [wp, v] of Object.entries(overrides)) {
        if (wp.startsWith("_")) continue;
        if (typeof v !== "string") { errors.push(`Override ${wp} must be a string.`); continue; }
        const parts = v.split(" > ");
        if (parts.length !== 3) { errors.push(`Override ${wp} malformed: ${JSON.stringify(v)}.`); continue; }
        if (!triples.has(parts.join("|"))) errors.push(`Override ${wp} → unknown triple "${v}".`);
      }
    }
  }

  function finish() {
    if (errors.length) {
      console.error(`[validate] ${errors.length} catalog issue(s):`);
      for (const e of errors) console.error("  - " + e);
      process.exit(13);
    }
    console.log("[validate] OK — schema, triple uniqueness, keyword uniqueness, overrides");
  }
  finish();
}

// ────────────────────────────────────────────────────────────────────────────
// list-wiki-pages
// ────────────────────────────────────────────────────────────────────────────
// (decodeWikiTitle is defined as a top-level helper above so render-per-l1
// can re-derive titles from wikiPath without depending on the cached field.)
function toWikiPath(rel) {
  return "/" + rel.replace(/\.md$/i, "").split(path.sep).join("/");
}
function parseFrontMatter(text) {
  const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  const product = m[1].match(/^\s*product\s*:\s*\[(.*?)\]\s*$/m);
  const tags = m[1].match(/^\s*tags\s*:\s*\[(.*?)\]\s*$/m);
  if (product) out.product = product[1].split(",").map(s => s.trim()).filter(Boolean);
  if (tags)    out.tags    = tags[1].split(",").map(s => s.trim()).filter(Boolean);
  return Object.keys(out).length ? out : null;
}
// Skip pages with only front-matter, :::template blocks, [[_TOC_]] tokens,
// HTML comments, and whitespace. The closing ::: must be at line start (/m).
function isContentEmpty(raw) {
  let s = raw
    .replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, "")
    .replace(/^[ \t]*:::[a-zA-Z][\w-]*[^\r\n]*\r?\n[\s\S]*?^[ \t]*:::[ \t]*\r?\n?/gm, "")
    .replace(/\[\[\s*_[A-Z][A-Z_]*_\s*\]\]/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, "");
  return s.length === 0;
}
async function walkWiki(root) {
  const excl = new Set(WIKI_CFG.excludedDirs.map(d => d.toLowerCase()));
  const out = [];
  async function rec(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (excl.has(e.name.toLowerCase())) continue;
        await rec(full);
      } else if (e.isFile() && /\.md$/i.test(e.name)) {
        out.push({ full, rel: path.relative(root, full), parentName: path.basename(path.dirname(full)) });
      }
    }
  }
  await rec(root);
  return out;
}
async function cmdListWikiPages() {
  const sourcesDir = process.env.SOURCES_DIR || process.cwd();
  const wikiRoot = process.env.WIKI_ROOT
    ? (path.isAbsolute(process.env.WIKI_ROOT) ? process.env.WIKI_ROOT : path.join(sourcesDir, process.env.WIKI_ROOT))
    : path.join(sourcesDir, WIKI_CFG.wikiRoot);

  console.log(`[list] wikiRoot = ${wikiRoot}`);
  if (!await exists(wikiRoot)) throw new Error(`Wiki root not found: ${wikiRoot}. Set WIKI_ROOT or clone it first.`);

  const files = await walkWiki(wikiRoot);
  console.log(`[list] discovered ${files.length} markdown pages`);

  const pages = [];
  let skipped = 0;
  for (const { full, rel, parentName } of files) {
    const raw = await fs.readFile(full, "utf8");
    if (isContentEmpty(raw)) { skipped++; continue; }
    pages.push({
      path: toWikiPath(rel),
      title: decodeWikiTitle(path.basename(rel, path.extname(rel))),
      relPath: rel.split(path.sep).join("/"),
      folder: parentName,
      frontMatter: parseFrontMatter(raw),
      content: raw.length > CONST.CHAR_LIMIT ? raw.slice(0, CONST.CHAR_LIMIT) + "\n…[truncated]" : raw,
      contentHash: sha256(raw)
    });
  }
  await fs.mkdir(OUT_DIR, { recursive: true });
  await writeJson(path.join(OUT_DIR, "wiki-pages.json"), pages);
  console.log(`[list] kept ${pages.length}, skipped ${skipped} empty/boilerplate`);

  // catalogHash gates the entire cache. ANY catalog or override edit invalidates.
  const catalogRaw   = await fs.readFile(SAP_FILE, "utf8");
  const overridesRaw = (await exists(OVR_FILE)) ? await fs.readFile(OVR_FILE, "utf8") : "";
  const hash = sha256(catalogRaw + "\n---\n" + overridesRaw);
  await fs.writeFile(path.join(OUT_DIR, "catalog-hash.txt"), hash + "\n", "utf8");
  console.log(`[list] catalogHash = ${hash.slice(0, 16)}…`);
}

// ────────────────────────────────────────────────────────────────────────────
// diff-pages
// ────────────────────────────────────────────────────────────────────────────
async function cmdDiffPages() {
  const pages       = await loadJson(path.join(OUT_DIR, "wiki-pages.json"));
  const currentHash = await loadText(path.join(OUT_DIR, "catalog-hash.txt"));
  const cacheDir    = path.join(OUT_DIR, "_cache");
  const cacheMapF   = path.join(cacheDir, "wiki-mapping.json");
  const cacheHashF  = path.join(cacheDir, "catalog-hash.txt");
  const cachePagesF = path.join(cacheDir, "wiki-pages.json");

  let reason, cacheMap = null, cacheHashOld = null, cachePages = null;
  if (!(await exists(cacheMapF)) || !(await exists(cacheHashF))) reason = "first-run";
  else {
    cacheHashOld = await loadText(cacheHashF);
    if (cacheHashOld !== currentHash) reason = "catalog-changed";
    else {
      reason = "incremental";
      cacheMap = await loadJson(cacheMapF);
      if (await exists(cachePagesF)) cachePages = await loadJson(cachePagesF);
    }
  }

  let changed = [], carryover = [];
  if (reason === "incremental") {
    const cacheByPath = new Map(cacheMap.map(e => [e.wikiPath, e]));
    const cachePagesByPath = cachePages ? new Map(cachePages.map(p => [p.path, p])) : null;
    for (const page of pages) {
      const ent = cacheByPath.get(page.path);
      const cachedHash = cachePagesByPath?.get(page.path)?.contentHash ?? null;
      if (ent && cachedHash !== null && cachedHash === page.contentHash) carryover.push(ent);
      else changed.push(page);
    }
  } else {
    changed = pages.slice();
  }

  await writeJson(path.join(OUT_DIR, "wiki-pages-changed.json"), changed);
  await writeJson(path.join(OUT_DIR, "wiki-mapping-carryover.json"), carryover);
  await writeJson(path.join(OUT_DIR, "diff-summary.json"), {
    totalCurrent: pages.length, carriedOver: carryover.length, toClassify: changed.length,
    reason, catalogHashChanged: reason === "catalog-changed",
    catalogHashCurrent: currentHash.slice(0, 16) + "…",
    catalogHashCached:  cacheHashOld ? cacheHashOld.slice(0, 16) + "…" : null
  });
  console.log(`[diff] reason=${reason}  total=${pages.length}  carryover=${carryover.length}  toClassify=${changed.length}`);
}

// ────────────────────────────────────────────────────────────────────────────
// prepare-l1-route
// ────────────────────────────────────────────────────────────────────────────
async function cmdPrepareL1Route() {
  const catalog = await loadJson(SAP_FILE);
  const pages   = await loadJson(path.join(OUT_DIR, "wiki-pages-changed.json"));
  const stage1  = path.join(OUT_DIR, "stage1");

  const byL1 = new Map(); const l1Order = [];
  for (const leaf of catalog) {
    if (!byL1.has(leaf.l1)) { byL1.set(leaf.l1, { leafCount: 0, l2Set: new Set(), l3Samples: [] }); l1Order.push(leaf.l1); }
    const b = byL1.get(leaf.l1);
    b.leafCount++;
    b.l2Set.add(leaf.l2);
    if (b.l3Samples.length < 6 && leaf.l3 !== CONST.GENERAL) b.l3Samples.push(leaf.l3);
  }
  const catalogL1 = l1Order.map(l1 => {
    const b = byL1.get(l1);
    const l2List = [...b.l2Set].slice(0, 8);
    const summary = `Covers ${b.leafCount} leaves across ${b.l2Set.size} L2 sub-topics. ` +
                    `L2s include: ${l2List.join(", ")}.` +
                    (b.l3Samples.length ? ` Example L3 user-intents: "${b.l3Samples.slice(0, 4).join('", "')}".` : "");
    return { l1, summary, leafCount: b.leafCount };
  });
  const input = pages.map(p => ({
    wikiPath: p.path, title: p.title, folder: p.folder, frontMatter: p.frontMatter,
    contentExcerpt: (p.content || "").slice(0, CONST.STAGE1_EXCERPT)
  }));
  await fs.mkdir(stage1, { recursive: true });
  await writeJson(path.join(stage1, "catalog-l1.json"), catalogL1);
  await writeJson(path.join(stage1, "input.json"), input);
  console.log(`[stage1] ${catalogL1.length} L1 buckets, ${input.length} pages to route`);
}

// ────────────────────────────────────────────────────────────────────────────
// prepare-l2l3-detail
// ────────────────────────────────────────────────────────────────────────────
async function cmdPrepareL2L3Detail() {
  const catalog   = await loadJson(SAP_FILE);
  const overrides = await loadJson(OVR_FILE, {});
  const pages     = await loadJson(path.join(OUT_DIR, "wiki-pages-changed.json"));
  const routing   = await loadJson(path.join(OUT_DIR, "stage1", "l1-routing.json"));
  const stage2    = path.join(OUT_DIR, "stage2");
  const overOut   = path.join(OUT_DIR, "wiki-mapping-overrides.json");

  const leafByTriple = new Map(catalog.map(l => [`${l.l1}|${l.l2}|${l.l3}`, l]));

  // 1. Apply manual overrides
  const overrideEntries = []; const overriddenPaths = new Set();
  for (const page of pages) {
    const v = overrides[page.path];
    if (!v) continue;
    const parts = v.split(" > ");
    if (parts.length !== 3) { console.warn(`[stage2] override for ${page.path} malformed: ${v}`); continue; }
    if (!leafByTriple.has(parts.join("|"))) { console.warn(`[stage2] override for ${page.path} → unknown triple: ${v}`); continue; }
    overrideEntries.push({
      wikiPath: page.path, title: page.title,
      l1: parts[0], l2: parts[1], l3: parts[2],
      confidence: 1.0, source: "override", reason: "Manual override"
    });
    overriddenPaths.add(page.path);
  }
  await fs.mkdir(OUT_DIR, { recursive: true });

  // 2. Index leaves by L1 and bucket pages by their Stage-1 L1.
  //    Pages with null/unknown L1 are recorded as no-match (skip Stage 2 AND cache).
  const subByL1 = new Map();
  for (const leaf of catalog) {
    if (!subByL1.has(leaf.l1)) subByL1.set(leaf.l1, []);
    subByL1.get(leaf.l1).push(leaf);
  }
  const routeBy = new Map(routing.map(r => [r.wikiPath, r]));
  const buckets = new Map();
  const noMatch = [];
  for (const page of pages) {
    if (overriddenPaths.has(page.path)) continue;
    const r = routeBy.get(page.path);
    const l1 = r && r.l1;
    if (!l1 || !subByL1.has(l1)) {
      noMatch.push({
        wikiPath: page.path, title: page.title,
        l1: null, l2: null, l3: null,
        confidence: 1.0, source: "no-match", reason: "No L1 matched in Stage 1 — dropped from report"
      });
      continue;
    }
    if (!buckets.has(l1)) buckets.set(l1, []);
    buckets.get(l1).push(page);
  }
  overrideEntries.push(...noMatch);
  await writeJson(overOut, overrideEntries);

  // 3. Write per-L1 (catalog, input-NNN) sets. Always batched (input-001.json).
  await fs.rm(stage2, { recursive: true, force: true });
  await fs.mkdir(stage2, { recursive: true });
  const indexBuckets = [];
  for (const [l1, pagesForL1] of buckets.entries()) {
    if (!pagesForL1.length) continue;
    const dir = path.join(stage2, slug(l1));
    await fs.mkdir(dir, { recursive: true });
    await writeJson(path.join(dir, "catalog.json"), subByL1.get(l1) || []);
    const batches = chunk(pagesForL1, CONST.BATCH_SIZE);
    for (let i = 0; i < batches.length; i++) {
      await writeJson(path.join(dir, `input-${pad3(i + 1)}.json`), batches[i]);
    }
    indexBuckets.push({
      l1, slug: slug(l1), count: pagesForL1.length,
      leafCount: (subByL1.get(l1) || []).length, batchCount: batches.length, batchSize: CONST.BATCH_SIZE
    });
  }
  const index = {
    overridesCount: overrideEntries.length - noMatch.length,
    noMatchCount:   noMatch.length,
    routedCount:    pages.length - overrideEntries.length,
    maxBatchSize:   CONST.BATCH_SIZE,
    buckets: indexBuckets.sort((a, b) => b.count - a.count)
  };
  await writeJson(path.join(stage2, "_index.json"), index);
  console.log(`[stage2] overrides=${index.overridesCount}  no-match=${index.noMatchCount}  batch-size=${CONST.BATCH_SIZE}`);
  for (const b of index.buckets) {
    console.log(`         ${b.l1.padEnd(28)} pages=${b.count}  leaves=${b.leafCount}  batches=${b.batchCount}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// consolidate-stage2
// ────────────────────────────────────────────────────────────────────────────
async function cmdConsolidateStage2() {
  const pages     = await loadJson(path.join(OUT_DIR, "wiki-pages-changed.json"));
  const overrides = await loadJson(path.join(OUT_DIR, "wiki-mapping-overrides.json"), []);
  const stage2    = path.join(OUT_DIR, "stage2");
  const index     = await loadJson(path.join(stage2, "_index.json"), { buckets: [] });

  const all = [], seen = new Set();
  for (const e of overrides) { all.push(e); seen.add(e.wikiPath); }

  for (const b of index.buckets) {
    const batchCount = b.batchCount || 1;
    const missing = [];
    for (let i = 1; i <= batchCount; i++) {
      const f = path.join(stage2, b.slug, `output-${pad3(i)}.json`);
      const arr = await loadJson(f, null);
      if (arr === null) { missing.push(`${b.slug}/output-${pad3(i)}.json`); continue; }
      if (!Array.isArray(arr)) throw new Error(`Stage-2 batch output not an array: ${f}`);
      for (const e of arr) { if (!seen.has(e.wikiPath)) { all.push(e); seen.add(e.wikiPath); } }
    }
    if (missing.length) {
      console.warn(`[consolidate] bucket "${b.l1}": ${missing.length}/${batchCount} batch file(s) missing`);
      for (const m of missing.slice(0, 5)) console.warn(`             - ${m}`);
    }
  }

  const total = pages.length;
  const missingPages = pages.filter(p => !seen.has(p.path)).map(p => p.path);
  if (missingPages.length) {
    console.warn(`[consolidate] WARNING: ${missingPages.length} changed page(s) have no Stage-2 entry.`);
    for (const p of missingPages.slice(0, 20)) console.warn(`             - ${p}`);
  }
  await writeJson(path.join(OUT_DIR, "wiki-mapping-changed.json"), all);
  console.log(`[consolidate] overrides=${overrides.length}  fromStage2=${all.length - overrides.length}  missing=${missingPages.length}`);
}

// ────────────────────────────────────────────────────────────────────────────
// merge-mapping
// ────────────────────────────────────────────────────────────────────────────
async function cmdMergeMapping() {
  const pages    = await loadJson(path.join(OUT_DIR, "wiki-pages.json"));
  const carry    = await loadJson(path.join(OUT_DIR, "wiki-mapping-carryover.json"), []);
  const changed  = await loadJson(path.join(OUT_DIR, "wiki-mapping-changed.json"), []);

  const byPath = new Map();
  for (const e of carry)   byPath.set(e.wikiPath, { ...e, source: e.source || "cache" });
  for (const e of changed) byPath.set(e.wikiPath, e);

  const merged = [], missing = [];
  for (const p of pages) {
    const e = byPath.get(p.path);
    if (e) merged.push(e); else missing.push(p.path);
  }

  let final = merged;
  if (missing.length) {
    console.warn(`[merge] WARNING: ${missing.length} page(s) had no mapping. Emitting placeholders.`);
    for (const p of missing.slice(0, 20)) console.warn(`        - ${p}`);
    const phByPath = new Map(pages.filter(p => missing.includes(p.path)).map(p => [p.path,
      { wikiPath: p.path, title: p.title, l1: null, l2: null, l3: null,
        confidence: 0, source: "placeholder", reason: "No mapping produced (upstream issue)" }]));
    final = pages.map(p => byPath.get(p.path) || phByPath.get(p.path));
  }
  await writeJson(path.join(OUT_DIR, "wiki-mapping.json"), final);
  await writeJson(path.join(OUT_DIR, "merge-summary.json"), {
    total: pages.length, fromCache: carry.length, fromAgent: changed.length, missingAfterMerge: missing.length
  });
  console.log(`[merge] total=${pages.length}  fromCache=${carry.length}  fromAgent=${changed.length}  missing=${missing.length}`);
}

// ────────────────────────────────────────────────────────────────────────────
// render-index (top-level INDEX page only — no separate Needs Review file)
// ────────────────────────────────────────────────────────────────────────────
async function cmdRenderIndex() {
  const entries = await loadJson(path.join(OUT_DIR, "wiki-mapping.json"));
  const catalog = await loadJson(SAP_FILE);
  const dropped    = entries.filter(e => e.l1 == null).length;
  const classified = entries.filter(e => e.l1 != null);

  // Render-stats from render-per-l1 (must run first). If absent, fall back
  // to raw classified counts so the index still renders even when invoked
  // out of order.
  const stats = await loadJson(path.join(OUT_DIR, "render-stats.json"), null);
  const shown       = stats ? stats.totalShown       : classified.length;
  const notIncluded = stats ? (stats.totalNotIncluded + dropped) : dropped;

  const l1Order = [], seenL1 = new Set();
  for (const leaf of catalog) if (!seenL1.has(leaf.l1)) { seenL1.add(leaf.l1); l1Order.push(leaf.l1); }
  for (const e of classified) if (!seenL1.has(e.l1)) { seenL1.add(e.l1); l1Order.push(e.l1); }

  const byL1 = new Map(l1Order.map(l1 => [l1, 0]));
  for (const e of classified) byL1.set(e.l1, byL1.get(e.l1) + 1);

  const ix = [];
  ix.push("# Wiki ↔ SAP Mapping", "");
  ix.push("## Description", "");
  ix.push("This wiki lists the wiki pages most relevant to each Support Area Path (SAP), organized by product. The mapping is generated automatically by AI and refreshed periodically.", "");
  ix.push(`_Generated at ${new Date().toISOString()}_`, "");
  ix.push("## Summary", "");
  ix.push(`- Wiki pages classified: **${shown}**`);
  ix.push(`- Wiki pages not included (insufficient relevance): **${notIncluded}**`);
  ix.push("", "## By product (L1)", "");
  ix.push("| L1 | Pages classified | Detail page |");
  ix.push("|--|--|--|");
  for (const l1 of l1Order) {
    const n = byL1.get(l1);
    if (!n) continue;
    ix.push(`| ${esc(l1)} | ${n} | [Wiki SAP Mapping ${esc(l1)}](${WIKI_URL_PREFIX}/${INDEX_PAGE_NAME}/${INDEX_PAGE_NAME}-${slug(l1)}) |`);
  }
  ix.push("");

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, `${INDEX_PAGE_NAME}.md`), ix.join("\n"), "utf8");
  console.log(`[render-index] wrote INDEX (shown=${shown} notIncluded=${notIncluded}${stats ? "" : " — stats fallback"})`);
}

// ────────────────────────────────────────────────────────────────────────────
// render-per-l1 — one md per L1, sections grouped by full leaf SAP path
// ────────────────────────────────────────────────────────────────────────────
async function cmdRenderPerL1() {
  console.log(`[render-per-l1] tunables: MIN_LEAF_SCORE_AI=${CONST.MIN_LEAF_SCORE_AI}  AI_CAP_NO_TITLE_HIT=${CONST.AI_CAP_NO_TITLE_HIT}  AI_CAP_ONE_TITLE_HIT=${CONST.AI_CAP_ONE_TITLE_HIT}  TITLE_MATCH_SCORE=${CONST.TITLE_MATCH_SCORE}  KEYWORD_TOKEN_RATIO=${CONST.KEYWORD_TOKEN_RATIO}  FALLBACK_MAX=${CONST.FALLBACK_MAX}  PER_LEAF_CAP=${CONST.PER_LEAF_CAP}`);
  const entries    = await loadJson(path.join(OUT_DIR, "wiki-mapping.json"));
  const catalog    = await loadJson(SAP_FILE);
  const classified = entries.filter(e => e.l1 != null);

  // Page content lookup (needed for keyword matching at filter time).
  // wiki-pages.json is the input snapshot from list-wiki-pages, still
  // present in out/ at render time (postAgentSteps trim runs LATER).
  const pages = await loadJson(path.join(OUT_DIR, "wiki-pages.json"), []);
  const contentByPath = new Map(pages.map(p => [p.path, p.content || ""]));

  // Build leaf ordering + leaf catalog object lookup (for keywords).
  // leafKey = `${l2}|${l3 || GENERAL}` (scoped per-L1)
  const l1Order = [], seenL1 = new Set();
  const leafOrderByL1 = new Map();    // l1 → array of leafKey
  const leafSeenByL1  = new Map();    // l1 → Set of leafKey
  const leafObjByKey  = new Map();    // `${l1}|${leafKey}` → leaf object (for keywords)
  for (const leaf of catalog) {
    if (!seenL1.has(leaf.l1)) {
      seenL1.add(leaf.l1); l1Order.push(leaf.l1);
      leafOrderByL1.set(leaf.l1, []);
      leafSeenByL1.set(leaf.l1, new Set());
    }
    const lk = `${leaf.l2}|${leaf.l3 || CONST.GENERAL}`;
    if (!leafSeenByL1.get(leaf.l1).has(lk)) {
      leafSeenByL1.get(leaf.l1).add(lk);
      leafOrderByL1.get(leaf.l1).push(lk);
    }
    leafObjByKey.set(`${leaf.l1}|${lk}`, leaf);
  }

  // Bucket classified entries by (L1, leafKey).
  const byL1Leaf = new Map();
  for (const e of classified) {
    if (!byL1Leaf.has(e.l1)) byL1Leaf.set(e.l1, new Map());
    const inner = byL1Leaf.get(e.l1);
    const lk = `${e.l2}|${e.l3 || CONST.GENERAL}`;
    if (!inner.has(lk)) inner.set(lk, []);
    inner.get(lk).push(e);
  }

  // Cross-leaf title-match injection (within same L1):
  //   For each leaf L with a non-(General) L3, scan all classified
  //   entries assigned to the same L1 by Stage 2; if an entry's TITLE
  //   contains the full L3 phrase (singular/plural-tolerant on the
  //   last token) AND the entry isn't already in L's bucket, copy it
  //   in with source="title-match". This catches pages whose title
  //   literally names the L3 but Stage 2 routed elsewhere
  //   (e.g. "Deletion of Dynamic Scope fails" → routed to a deletion-
  //   error leaf, but the title clearly belongs under "Dynamic Scopes"
  //   and should appear there too).
  // The original entry stays in its Stage-2 leaf; the injected copy
  // is a duplicate marked with source="title-match". Both render.
  let totalTitleMatchInjected = 0;
  for (const [l1, leafMap] of byL1Leaf.entries()) {
    // Snapshot all entries in this L1 (across all leaves) before mutation.
    const allInL1 = [...leafMap.values()].flat();
    const order = leafOrderByL1.get(l1) || [];
    for (const lk of order) {
      const leafObj = leafObjByKey.get(`${l1}|${lk}`);
      const re = l3MatchRegex(leafObj?.l3);
      if (!re) continue;
      // Existing bucket (may be undefined if Stage 2 didn't assign here);
      // we only materialise it when we actually have something to push,
      // otherwise we'd leave behind empty buckets that the fallback
      // render loop would emit as headers-only sections.
      let bucket   = leafMap.get(lk);
      const inBucket = new Set(bucket ? bucket.map(e => e.wikiPath) : []);
      for (const e of allInL1) {
        if (inBucket.has(e.wikiPath)) continue;
        if (!titleMatchesL3(e, re)) continue;
        if (!bucket) { bucket = []; leafMap.set(lk, bucket); }
        bucket.push({
          ...e,
          l2: leafObj.l2, l3: leafObj.l3,
          source: "title-match",
          reason: `Title contains L3 phrase "${leafObj.l3}" (originally classified to ${e.l2}/${e.l3})`,
          confidence: CONST.TITLE_MATCH_SCORE
        });
        inBucket.add(e.wikiPath);
        totalTitleMatchInjected++;
      }
    }
  }
  if (totalTitleMatchInjected > 0) {
    console.log(`[render-per-l1] title-match injection: ${totalTitleMatchInjected} cross-leaf copy(s) added (source=title-match)`);
  }

  // Cross-leaf lexical fallback for empty leaves:
  //   Stage 2 assigns each page to ONE leaf, so leaves the model didn't
  //   pick end up with 0 entries. For UX we want every catalog leaf to
  //   surface at least one wiki page (the closest lexical match in the
  //   same L1) rather than render an empty section. This step is purely
  //   ADDITIVE — it only fills buckets that are empty after Stage 2 and
  //   title-match. It NEVER removes or modifies entries the previous
  //   logic captured.
  //
  //   Lexical fit per (page, leaf) = sum of leaf-token whole-word hits:
  //     title hit × 1.0
  //     path  hit × 0.4   (folder-name noise is the reason for downweighting)
  //     body  hit × 0.15  (8KB content has high incidental-hit rate)
  //   Leaf tokens = significant tokens of (L3 + L2 + every keyword).
  //   Source = "leaf-fallback", bypasses Rule C / anchor cap.
  //   If 0 same-L1 pages have ANY token overlap, the leaf legitimately
  //   has no wiki coverage in this L1 — leaf stays empty.
  const computeLexicalFit = (e, leafTokSet) => {
    if (leafTokSet.size === 0) return 0;
    const title = (e.title && String(e.title).trim()) || titleFromWikiPath(e.wikiPath || "");
    const lTitle = title.toLowerCase();
    const lPath  = (e.wikiPath || "").toLowerCase();
    const lBody  = (contentByPath.get(e.wikiPath) || "").toLowerCase();
    let score = 0;
    for (const t of leafTokSet) {
      const re = new RegExp(`\\b${escapeRegex(t)}\\b`, "i");
      if (re.test(lTitle))      score += 1.0;
      else if (re.test(lPath))  score += 0.4;
      else if (re.test(lBody))  score += 0.15;
    }
    return score;
  };

  let totalLeafFallbackInjected = 0;
  for (const [l1, leafMap] of byL1Leaf.entries()) {
    const allInL1 = [...leafMap.values()].flat();
    const order   = leafOrderByL1.get(l1) || [];
    for (const lk of order) {
      const bucket = leafMap.get(lk);
      if (bucket && bucket.length > 0) continue;          // skip non-empty leaves — additive only
      const leafObj = leafObjByKey.get(`${l1}|${lk}`);
      if (!leafObj) continue;
      // Build leaf token set: keywords + L3 (skip "(General)") + L2.
      // L2 is included to help leaves whose L3 is "(General)" sentinel
      // and to widen recall — fallback intentionally uses broader signals
      // than anchor cap.
      const leafTokSet = new Set();
      for (const kw of leafObj.keywords || []) for (const t of kwTokens(kw)) leafTokSet.add(t);
      if (leafObj.l3 && leafObj.l3 !== CONST.GENERAL) for (const t of kwTokens(leafObj.l3)) leafTokSet.add(t);
      if (leafObj.l2) for (const t of kwTokens(leafObj.l2)) leafTokSet.add(t);
      if (leafTokSet.size === 0) continue;
      const ranked = allInL1
        .map(e => ({ e, fit: computeLexicalFit(e, leafTokSet) }))
        .filter(x => x.fit > 0)
        .sort((a, b) => (b.fit - a.fit) || a.e.wikiPath.localeCompare(b.e.wikiPath))
        .slice(0, CONST.FALLBACK_MAX);
      if (ranked.length === 0) continue;
      const newBucket = ranked.map(({ e, fit }) => ({
        ...e,
        l2: leafObj.l2, l3: leafObj.l3,
        source: "leaf-fallback",
        reason: `Lexical best-match for empty leaf "${leafObj.l3}" (token-fit ${fit.toFixed(2)}; originally classified to ${e.l2}/${e.l3})`,
        // Confidence in [0.40, 0.70] — visibly low to convey "weak match"
        // but still passes Rule C MIN_LEAF_SCORE_AI gate (0.55) when fit ≥ ~1.5.
        confidence: Math.min(0.40 + fit * 0.10, 0.70)
      }));
      leafMap.set(lk, newBucket);
      totalLeafFallbackInjected += newBucket.length;
    }
  }
  if (totalLeafFallbackInjected > 0) {
    console.log(`[render-per-l1] leaf-fallback injection: ${totalLeafFallbackInjected} entry(ies) added for empty leaves (source=leaf-fallback)`);
  }

  // Strict filter (Rule C):
  //   keep if source is override / rule (deterministic sources always trusted)
  //   keep if source is ai AND compositeScore ≥ MIN_LEAF_SCORE_AI AND
  //         at least 1 leaf keyword appears in page title/path/content as a
  //         whole word (\b...\b match, case-insensitive)
  //   Fallback: if 0 pages pass for a leaf, keep the top FALLBACK_MAX
  //   by composite score so the leaf section is not empty.
  // Build a "matcher" for one keyword phrase.
  //   - 0 sig tokens (all stopwords / too short): fall back to the raw
  //     phrase as a literal whole-word match (handles oddities like all
  //     keywords being single short words).
  //   - 1 sig token: standard \b<word>\b whole-word match.
  //   - N≥2 sig tokens: require ≥ ceil(N * RATIO) tokens present as
  //     whole words in the haystack (no adjacency required).
  // (kwTokens itself is hoisted to top-level so compositeScore can use
  // it for the title-overlap anchor cap.)
  const buildMatcher = phrase => {
    const toks = kwTokens(phrase);
    if (toks.length <= 1) {
      const word = toks[0] || phrase.trim().toLowerCase();
      const re = new RegExp(`\\b${escapeRegex(word)}\\b`, "i");
      return hay => re.test(hay);
    }
    const need = Math.max(2, Math.ceil(toks.length * CONST.KEYWORD_TOKEN_RATIO));
    const res  = toks.map(t => new RegExp(`\\b${escapeRegex(t)}\\b`, "i"));
    return hay => {
      let hits = 0;
      for (const re of res) if (re.test(hay) && ++hits >= need) return true;
      return false;
    };
  };

  let totalKept = 0, totalFilteredOut = 0, totalFallback = 0;
  let totalShown = 0, totalCappedOut = 0;
  const applyStrictFilter = (rows, leafObj) => {
    const scored = rows
      .map(e => ({ ...e, _score: compositeScore(e, leafObj) }))
      .sort((a, b) => (b._score - a._score) || a.wikiPath.localeCompare(b.wikiPath));

    const matchers = (leafObj?.keywords || [])
      .filter(k => typeof k === "string" && k.trim().length > 0)
      .map(buildMatcher);

    const matchesAnyKeyword = e => {
      if (matchers.length === 0) return false;
      const hay = `${e.title || ""} ${e.wikiPath || ""} ${contentByPath.get(e.wikiPath) || ""}`.toLowerCase();
      return matchers.some(m => m(hay));
    };

    const passing = scored.filter(e => {
      if (e.source === "override")      return true;
      if (e.source === "rule")          return true;   // rule path already required ≥2 keywords at Stage 2
      if (e.source === "title-match")   return true;   // L3 phrase appears verbatim in the title
      if (e.source === "leaf-fallback") return true;   // empty-leaf rescue, score reflects weak fit
      // AI path: BOTH conditions must hold
      return e._score >= CONST.MIN_LEAF_SCORE_AI && matchesAnyKeyword(e);
    });

    if (passing.length > 0) {
      totalKept       += passing.length;
      totalFilteredOut += scored.length - passing.length;
      return passing;
    }
    // Fallback: keep top-N by score so the leaf still has visible content
    const fb = scored.slice(0, Math.min(CONST.FALLBACK_MAX, scored.length));
    totalFallback    += fb.length;
    totalFilteredOut += scored.length - fb.length;
    return fb;
  };

  const renderLeafSection = (heading, rows, leafObj) => {
    const filtered = applyStrictFilter(rows, leafObj);
    const capped   = filtered.slice(0, CONST.PER_LEAF_CAP);
    totalShown    += capped.length;
    totalCappedOut += Math.max(0, filtered.length - capped.length);
    const visible  = capped.slice(0, CONST.VISIBLE_PER_LEAF);
    const more     = capped.slice(CONST.VISIBLE_PER_LEAF);

    const lines = [`## ${heading}`, ""];
    const tableHead = ["| Wiki Path | Score |", "|--|--|"];
    const renderRow = e => `| ${wikiLink(e)} | ${e._score.toFixed(2)} |`;

    lines.push(...tableHead);
    for (const e of visible) lines.push(renderRow(e));
    lines.push("");

    if (more.length > 0) {
      lines.push(`<details><summary><b>More</b> — ${more.length} additional page${more.length === 1 ? "" : "s"}</summary>`, "");
      lines.push(...tableHead);
      for (const e of more) lines.push(renderRow(e));
      lines.push("", "</details>", "");
    }
    // No "…and N more not shown" footer — pages beyond cap silently dropped.
    return lines;
  };

  // Per-L1 files are written flat into OUT_DIR (no per-l1/ subfolder)
  // so the published wiki tree is wiki-sap-mapping/*.md (single level).
  await fs.mkdir(OUT_DIR, { recursive: true });
  let written = 0;
  for (const l1 of l1Order) {
    const leafMap = byL1Leaf.get(l1);
    if (!leafMap || leafMap.size === 0) continue;
    const totalForL1 = [...leafMap.values()].reduce((n, arr) => n + arr.length, 0);

    const lines = [];
    lines.push(`# Wiki ↔ SAP Mapping — ${l1}`, "");
    lines.push("_Auto-generated. Do not edit by hand._");
    lines.push(`_Generated at ${new Date().toISOString()}_`, "");
    lines.push(`[← Back to index](${WIKI_URL_PREFIX}/${INDEX_PAGE_NAME})`, "");
    lines.push("## Summary", "");
    lines.push(`- Pages classified to this L1: **${totalForL1}**`);
    lines.push(`- Leaves with mapped pages: **${leafMap.size}**`);
    lines.push(`- Each leaf shows up to **${CONST.PER_LEAF_CAP}** wiki pages ranked by composite Score; first **${CONST.VISIBLE_PER_LEAF}** visible, the rest in an expandable "More" block.`, "");

    // Render leaves in catalog declaration order, then any unknown leaves
    // (shouldn't happen but defensive).
    const order = leafOrderByL1.get(l1) || [];
    const renderedKeys = new Set();
    for (const lk of order) {
      const rows = leafMap.get(lk);
      if (!rows || rows.length === 0) continue;
      const [l2, l3] = lk.split("|");
      const heading = l3 === CONST.GENERAL ? `${l1}/${l2}` : `${l1}/${l2}/${l3}`;
      lines.push(...renderLeafSection(heading, rows, leafObjByKey.get(`${l1}|${lk}`)));
      renderedKeys.add(lk);
    }
    for (const [lk, rows] of leafMap.entries()) {
      if (renderedKeys.has(lk)) continue;
      if (!rows || rows.length === 0) continue;
      const [l2, l3] = lk.split("|");
      const heading = l3 === CONST.GENERAL ? `${l1}/${l2}` : `${l1}/${l2}/${l3}`;
      lines.push(...renderLeafSection(heading, rows, leafObjByKey.get(`${l1}|${lk}`)));
    }

    await fs.writeFile(path.join(OUT_DIR, `${INDEX_PAGE_NAME}-${slug(l1)}.md`), lines.join("\n"), "utf8");
    written++;
  }
  console.log(`[render-per-l1] wrote ${written} per-L1 file(s)`);
  console.log(`[render-per-l1] strict filter (Rule C, MIN_LEAF_SCORE_AI=${CONST.MIN_LEAF_SCORE_AI}):`);
  console.log(`                kept=${totalKept}  filteredOut=${totalFilteredOut}  fallback=${totalFallback}  cappedOut=${totalCappedOut}`);
  console.log(`                shown=${totalShown}  notIncluded(per-leaf)=${totalFilteredOut + totalCappedOut}`);

  // Persist stats so cmdRenderIndex can produce a Summary that reflects
  // post-filter visibility (rather than raw classified counts).
  await writeJson(path.join(OUT_DIR, "render-stats.json"), {
    totalShown,
    totalNotIncluded: totalFilteredOut + totalCappedOut,
    totalKept,
    totalFallback,
    totalFilteredOut,
    totalCappedOut,
    minLeafScoreAi: CONST.MIN_LEAF_SCORE_AI,
    perLeafCap:     CONST.PER_LEAF_CAP,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// publish-mapping
// Source layout (flat in out/):
//   out/Wiki-SAP-Mapping.md
//   out/Wiki-SAP-Mapping-<L1>.md
// Destination layout (under repo, ADO Code Wiki convention — INDEX page +
// child folder of the same name for sub-pages):
//   AAAP_CodeWiki/Draft/Nina/Wiki-SAP-Mapping.md           ← INDEX
//   AAAP_CodeWiki/Draft/Nina/Wiki-SAP-Mapping/Wiki-SAP-Mapping-<L1>.md
// ────────────────────────────────────────────────────────────────────────────
async function cmdPublishMapping() {
  const SRC_DIR     = OUT_DIR;
  const DST_PARENT  = path.resolve(process.cwd(), PUBLISH_PARENT_DIR);   // .../Draft/Nina/
  const DST_CHILD   = path.join(DST_PARENT, INDEX_PAGE_NAME);            // .../Draft/Nina/Wiki-SAP-Mapping/
  const INDEX_FILE  = `${INDEX_PAGE_NAME}.md`;
  const PER_L1_PFX  = `${INDEX_PAGE_NAME}-`;

  const indexSrc = path.join(SRC_DIR, INDEX_FILE);
  if (!(await exists(indexSrc))) {
    console.error(`[publish] missing ${indexSrc} — run render-per-l1 + render-index first.`); process.exit(1);
  }
  const readMaybe = async p => { try { return await fs.readFile(p, "utf8"); } catch { return null; } };
  const sync = async (src, dst) => {
    const nu = await readMaybe(src); if (nu === null) return { s: "missing-source" };
    const old = await readMaybe(dst);
    if (old === nu) return { s: "unchanged" };
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.writeFile(dst, nu, "utf8");
    return { s: old === null ? "created" : "updated" };
  };
  const listMd = async d => !(await exists(d)) ? []
    : (await fs.readdir(d, { withFileTypes: true })).filter(e => e.isFile() && e.name.endsWith(".md")).map(e => e.name);

  await fs.mkdir(DST_CHILD, { recursive: true });
  const results = [];

  // 1. INDEX → DST_PARENT/Wiki-SAP-Mapping.md
  results.push(await sync(indexSrc, path.join(DST_PARENT, INDEX_FILE)));

  // 2. Per-L1 *.md (anything matching Wiki-SAP-Mapping-*.md in out/) → DST_CHILD/
  const srcMd  = (await listMd(SRC_DIR))
    .filter(n => n.startsWith(PER_L1_PFX) && n !== INDEX_FILE);
  const dstMd  = (await listMd(DST_CHILD))
    .filter(n => n.startsWith(PER_L1_PFX));
  for (const n of srcMd) results.push(await sync(path.join(SRC_DIR, n), path.join(DST_CHILD, n)));

  // 3. Remove orphan per-L1 files (L1 dropped to zero pages this run).
  const srcSet = new Set(srcMd);
  for (const n of dstMd) if (!srcSet.has(n)) {
    await fs.unlink(path.join(DST_CHILD, n));
    results.push({ s: "deleted" });
  }

  const tally = results.reduce((m, r) => (m[r.s] = (m[r.s] || 0) + 1, m), {});
  console.log(`[publish] dst INDEX  = ${path.relative(process.cwd(), path.join(DST_PARENT, INDEX_FILE))}`);
  console.log(`[publish] dst PER-L1 = ${path.relative(process.cwd(), DST_CHILD)}/`);
  console.log("[publish] sync summary:");
  for (const [s, n] of Object.entries(tally)) console.log(`  ${s.padEnd(12)} ${n}`);
  const changed = (tally.created || 0) + (tally.updated || 0) + (tally.deleted || 0);
  if (changed === 0) console.log("[publish] no markdown changes — Agency PR will be empty and abandoned.");
  else console.log(`[publish] ${changed} markdown change(s) ready for Agency to commit.`);
}

// ────────────────────────────────────────────────────────────────────────────
// Dispatcher
// ────────────────────────────────────────────────────────────────────────────
const CMDS = {
  "validate-catalog":    cmdValidateCatalog,
  "list-wiki-pages":     cmdListWikiPages,
  "diff-pages":          cmdDiffPages,
  "prepare-l1-route":    cmdPrepareL1Route,
  "prepare-l2l3-detail": cmdPrepareL2L3Detail,
  "consolidate-stage2":  cmdConsolidateStage2,
  "merge-mapping":       cmdMergeMapping,
  "render-index":        cmdRenderIndex,
  "render-per-l1":       cmdRenderPerL1,
  "publish-mapping":     cmdPublishMapping
};

const cmd = process.argv[2];
if (!cmd || !CMDS[cmd]) {
  console.error(`Usage: node wiki-sap.mjs <command>\nCommands:\n  ${Object.keys(CMDS).join("\n  ")}`);
  process.exit(2);
}
CMDS[cmd]().catch(e => { console.error(e); process.exit(1); });
