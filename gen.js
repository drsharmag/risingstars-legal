const fs = require("fs");
const err = (...a) => console.log("::error::" + a.join(" ").slice(0, 300));
const SIGNS = ["Aries","Taurus","Gemini","Cancer","Leo","Virgo","Libra","Scorpio","Sagittarius","Capricorn","Aquarius","Pisces"];
const day = o => new Date(Date.now() + (330 + o * 1440) * 6e4).toISOString().slice(0, 10);
const dates = [day(0), day(1)];
const tok = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const gkey = process.env.GEMINI_API_KEY;
const note = m => console.log("::error::" + String(m).replace(/\s+/g, " ").slice(0, 400));
const GH = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
let MODELS = ["openai/gpt-4.1-mini", "openai/gpt-4o-mini", "openai/gpt-4.1"];
const prompt = (d, signs) => `Write original daily horoscopes for ${d}, for entertainment, for an Indian audience. Signs: ${signs.join(", ")}. For each sign give: love (one friendly sentence, max 18 words), work (one sentence, max 18 words), love_hi and work_hi (the same two sentences in natural Hindi), num (lucky number 1-99), col (lucky colour in English). No medical, money-guarantee, death or accident predictions. Do not mention the date. Return ONLY JSON: {"Aries":{"love":"","work":"","love_hi":"","work_hi":"","num":7,"col":"Gold"}} with exactly these signs.`;
const parse = s => JSON.parse(String(s).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
async function pickModels() {
  if (!tok) return;
  try {
    const r = await fetch("https://models.github.ai/catalog/models", { headers: { ...GH, Authorization: "Bearer " + tok } });
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
        body: JSON.stringify({ model: m, messages: [{ role: "user", content: p }], temperature: 0.9, response_format: { type: "json_object" } }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) return parse(j.choices[0].message.content);
      last = m + " -> HTTP " + r.status + " " + JSON.stringify(j).slice(0, 220);
    } catch (e) { last = m + " -> " + e.message; }
  }
  throw new Error("GitHub AI failed: " + last);
}
async function gemini(p) {
  let last = "";
  for (const m of ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"]) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${gkey}`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: p }] }], generationConfig: { responseMimeType: "application/json" } }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return parse(j.candidates[0].content.parts[0].text);
    last = m + " -> HTTP " + r.status + " " + ((j.error && j.error.message) || "").slice(0, 150);
  }
  throw new Error("Gemini failed: " + last);
}
const providers = [];
if (tok) providers.push(github);
if (gkey) providers.push(gemini);
async function chunk(d, signs) {
  for (const f of providers) {
    try { const o = await f(prompt(d, signs)); if (signs.every(s => o[s] && o[s].love && o[s].work)) return o; note("Answer was incomplete for " + signs.join(",")); }
    catch (e) { note(e.message || e); }
  }
  return {};
}
(async () => {
  if (!providers.length) { note("No AI is available: the workflow gave no GITHUB_TOKEN and there is no GEMINI_API_KEY secret."); process.exit(1); }
  await pickModels();
  const out = {};
  for (const d of dates) { out[d] = {}; for (let i = 0; i < 12; i += 4) Object.assign(out[d], await chunk(d, SIGNS.slice(i, i + 4))); }
  const got = dates.reduce((n, d) => n + Object.keys(out[d]).length, 0);
  console.log("signs written:", got, "of", dates.length * 12);
  if (!got) err("No horoscope was written. Reasons are listed above. If GitHub Models says forbidden or not enabled, add a GEMINI_API_KEY secret.");
  if (!got) { note("No horoscopes were written. The reasons are listed above."); process.exit(1); }
  let old = {}; try { old = JSON.parse(fs.readFileSync("daily.json", "utf8")); } catch (e) {}
  const keep = {}; for (const k of Object.keys(old)) if (k >= day(-2) && !out[k]) keep[k] = old[k];
  fs.writeFileSync("daily.json", JSON.stringify({ ...keep, ...out }));
})();
