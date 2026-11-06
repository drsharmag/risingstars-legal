const fs = require("fs");
const err = (...a) => console.log("::error::" + a.join(" ").slice(0, 300));
const SIGNS = ["Aries","Taurus","Gemini","Cancer","Leo","Virgo","Libra","Scorpio","Sagittarius","Capricorn","Aquarius","Pisces"];
const day = o => new Date(Date.now() + (330 + o * 1440) * 6e4).toISOString().slice(0, 10);
// Tomorrow first: it is the date the app needs at midnight; today may already be partly stored.
const dates = [day(1), day(0)];
const tok = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const gkey = process.env.GEMINI_API_KEY;
const note = m => console.log("::error::" + String(m).replace(/\s+/g, " ").slice(0, 400));
const GH = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
let MODELS = ["openai/gpt-4.1-mini", "openai/gpt-4o-mini"];
const prompt = (d, signs) => `Write original daily horoscopes for ${d}, for entertainment, for an Indian audience. Signs: ${signs.join(", ")}. For each sign give: love (one friendly sentence, max 18 words), work (one sentence, max 18 words), love_hi and work_hi (the same two sentences in natural Hindi), num (lucky number 1-99), col (lucky colour in English). No medical, money-guarantee, death or accident predictions. Do not mention the date. Return ONLY JSON: {"Aries":{"love":"","work":"","love_hi":"","work_hi":"","num":7,"col":"Gold"}} with exactly these signs.`;
const parse = s => JSON.parse(String(s).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
// --- Time bounds (fix: no fetch could hang for ~5 min; a run could take hours) ---
const START = Date.now();
const DEADLINE = START + 8 * 60 * 1000; // stop starting new work ~8 min in, write what we have
const pastDeadline = () => Date.now() >= DEADLINE;
const FETCH_TIMEOUT_MS = Number(process.env.GEN_FETCH_TIMEOUT_MS) || 40000;
const tmo = () => AbortSignal.timeout(FETCH_TIMEOUT_MS);
const sleep = ms => new Promise(res => setTimeout(res, ms));
// Honour Retry-After on 429/503 (seconds or HTTP-date), capped at 30 s; fall back to defMs.
function retryWaitMs(r, defMs) {
  try {
    const ra = r && r.headers && r.headers.get && r.headers.get("retry-after");
    if (ra) {
      const s = Number(ra);
      if (isFinite(s)) return Math.min(Math.max(s, 0) * 1000, 30000);
      const t = Date.parse(ra);
      if (isFinite(t)) return Math.min(Math.max(t - Date.now(), 0), 30000);
    }
  } catch (e) {}
  return defMs;
}
async function pickModels() {
  if (!tok) return;
  try {
    const r = await fetch("https://models.github.ai/catalog/models", { headers: { ...GH, Authorization: "Bearer " + tok }, signal: tmo() });
    if (!r.ok) throw new Error("model list " + r.status);
    const ids = (await r.json()).map(m => m.id), have = MODELS.filter(m => ids.includes(m));
    if (have.length) MODELS = have;
    else { MODELS = ids.filter(i => /mini|small|llama|flash/i.test(i)).slice(0, 3); note("Preferred models not in your catalog. Trying: " + MODELS.join(", ")); }
  } catch (e) { note("Could not read model list: " + e.message + " (using defaults)"); }
}
async function github(p) {
  let last = "no model";
  for (const m of MODELS) {
    try {
      const r = await fetch("https://models.github.ai/inference/chat/completions", { method: "POST",
        headers: { ...GH, "Content-Type": "application/json", Authorization: "Bearer " + tok },
        body: JSON.stringify({ model: m, messages: [{ role: "user", content: p }], temperature: 0.9, response_format: { type: "json_object" } }),
        signal: tmo() });
      const t = await r.text(); let j;
      try { j = JSON.parse(t); } catch (e) { last = m + " -> HTTP " + r.status + " reply was not JSON: " + JSON.stringify(t.slice(0, 120)); continue; }
      if (r.ok && j.choices && j.choices[0]) return parse(j.choices[0].message.content);
      last = m + " -> HTTP " + r.status + " " + JSON.stringify(j).slice(0, 220);
      if (r.status === 429 && !pastDeadline()) await sleep(retryWaitMs(r, 0)); // honour Retry-After before the next model
    } catch (e) { last = m + " -> " + e.message; }
  }
  throw new Error("GitHub AI failed: " + last);
}
async function gemini(p) {
  let last = "";
  for (const m of ["gemini-flash-latest", "gemini-2.5-flash"]) for (let tryN = 0; tryN < 2; tryN++) {
    let r, j;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${gkey}`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: p }] }], generationConfig: { responseMimeType: "application/json" } }),
        signal: tmo() });
      j = await r.json().catch(() => ({}));
    } catch (e) { last = m + " -> " + e.message; break; } // network error / timeout: next model
    if (r.ok && j.candidates && j.candidates[0]) return parse(j.candidates[0].content.parts[0].text);
    last = m + " -> HTTP " + r.status + " " + ((j.error && j.error.message) || "").slice(0, 150);
    if (r.status !== 503 && r.status !== 429) break;
    if (tryN < 1 && !pastDeadline()) await sleep(retryWaitMs(r, 5000)); // Retry-After honoured, cap 30 s
  }
  throw new Error("Gemini failed: " + last);
}
// Providers carry circuit-breaker state for the whole run (main pass + the one retry pass).
const providerState = [];
if (tok) providerState.push({ name: "GitHub Models", fn: github, fails: 0, dead: false });
if (gkey) providerState.push({ name: "Gemini", fn: gemini, fails: 0, dead: false });
const chunkLog = [];   // "date [signs]: provider +n" per provider attempt that produced signs
const firstError = {}; // provider name -> first error message this run
// Ask providers, in order, for only the signs still missing; keep every valid sign any
// provider returns (per-sign validation), instead of discarding a partial chunk.
async function fill(d, signs) {
  const gotSigns = {};
  let missing = [...signs];
  for (const p of providerState) {
    if (!missing.length) break;
    if (p.dead) continue;
    if (pastDeadline()) { note("Deadline reached; not starting new provider calls."); break; }
    let o = null, errMsg = null;
    try { o = await p.fn(prompt(d, missing)); } catch (e) { errMsg = (e && e.message) || String(e); }
    const valid = {};
    if (o) for (const s of missing) if (o[s] && o[s].love && o[s].work) valid[s] = o[s];
    const n = Object.keys(valid).length;
    if (n) {
      Object.assign(gotSigns, valid);
      chunkLog.push(d + " [" + missing.join(", ") + "]: " + p.name + " +" + n);
      p.fails = 0;
      missing = missing.filter(s => !valid[s]);
    } else {
      p.fails++;
      if (!firstError[p.name]) firstError[p.name] = errMsg || "returned no valid signs";
      note(errMsg ? p.name + " failed: " + errMsg : p.name + " answer had no valid signs for " + missing.join(","));
      if (p.fails >= 2) { p.dead = true; note(p.name + " skipped for the rest of this run after 2 consecutive failures."); }
    }
  }
  return gotSigns;
}
const count = (o, d) => Object.keys((o && o[d]) || {}).length;
(async () => {
  if (!providerState.length) { note("No AI is available: the workflow gave no GITHUB_TOKEN and there is no GEMINI_API_KEY secret."); process.exit(1); }
  let old = {}; try { old = JSON.parse(fs.readFileSync("daily.json", "utf8")); } catch (e) {}
  const before = {}; for (const d of dates) before[d] = count(old, d);
  await pickModels(); // actually call it: adapt MODELS to this account's catalog (defaults stay as fallback)
  const out = {};
  for (const d of dates) {
    out[d] = {};
    for (let i = 0; i < 12; i += 4) { if (pastDeadline()) break; Object.assign(out[d], await fill(d, SIGNS.slice(i, i + 4))); }
  }
  // ONE extra pass over still-missing signs; circuit-breaker state carries over.
  for (const d of dates) {
    const miss = SIGNS.filter(s => !out[d][s]);
    for (let i = 0; i < miss.length; i += 4) { if (pastDeadline()) break; Object.assign(out[d], await fill(d, miss.slice(i, i + 4))); }
  }
  const got = dates.reduce((n, d) => n + Object.keys(out[d]).length, 0);
  console.log("signs written:", got, "of", dates.length * 12);
  // Merge: old signs first, new signs on top. A date can never end with fewer signs
  // than it already had, and a date with 0 signs is never written.
  const keep = {}; for (const k of Object.keys(old)) if (k >= day(-2) && !dates.includes(k)) keep[k] = old[k];
  const merged = { ...keep };
  for (const d of dates) { const m = { ...(old[d] || {}), ...out[d] }; if (Object.keys(m).length) merged[d] = m; }
  const after = {}; for (const d of dates) after[d] = count(merged, d);
  // --- Run summary: console + GitHub step summary (readable without opening logs) ---
  const lines = ["## Daily horoscopes run summary", ""];
  for (const d of dates) lines.push("- " + d + ": " + before[d] + " -> " + after[d] + " signs stored (new this run: " + Object.keys(out[d]).length + ")");
  lines.push("", "Provider results per chunk:");
  if (chunkLog.length) for (const c of chunkLog) lines.push("- " + c); else lines.push("- (no provider produced any sign)");
  lines.push("", "First error per provider:");
  const pk = Object.keys(firstError);
  if (pk.length) for (const k of pk) lines.push("- " + k + ": " + firstError[k]); else lines.push("- (none)");
  if (pastDeadline()) lines.push("", "Note: the in-code deadline (~8 min) was reached; remaining signs were not attempted.");
  const summary = lines.join("\n");
  console.log(summary);
  try { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n"); } catch (e) {}
  // Exit policy: fail ONLY when nothing at all was generated AND some target date is
  // still incomplete in the stored file. On that failure nothing is written, so a
  // dead-provider night can never poison daily.json.
  if (!got && dates.some(d => after[d] < 12)) {
    err("No horoscope was written. Reasons are listed above. If GitHub Models says forbidden or not enabled, add a GEMINI_API_KEY secret.");
    process.exit(1);
  }
  fs.writeFileSync("daily.json", JSON.stringify(merged));
})();
