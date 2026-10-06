const fs = require("fs");
const SIGNS = ["Aries","Taurus","Gemini","Cancer","Leo","Virgo","Libra","Scorpio","Sagittarius","Capricorn","Aquarius","Pisces"];
const day = o => new Date(Date.now() + (330 + o * 1440) * 6e4).toISOString().slice(0, 10);
const dates = [day(0), day(1)];
const prompt = (d, signs) => `Write original daily horoscopes for ${d}, for entertainment, for an Indian audience. Signs: ${signs.join(", ")}. For each sign give: love (one friendly sentence, max 18 words), work (one sentence, max 18 words), love_hi and work_hi (the same two sentences in natural Hindi), num (lucky number 1-99), col (lucky colour in English). No medical, money-guarantee, death or accident predictions. Do not mention the date. Return ONLY JSON: {"Aries":{"love":"","work":"","love_hi":"","work_hi":"","num":7,"col":"Gold"}} with exactly these signs.`;
async function github(p) {
  const r = await fetch("https://models.github.ai/inference/chat/completions", { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.GITHUB_TOKEN },
    body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: p }], temperature: 0.9, response_format: { type: "json_object" } }) });
  const j = await r.json(); if (!r.ok) throw new Error("github " + r.status + " " + JSON.stringify(j).slice(0, 160));
  return JSON.parse(j.choices[0].message.content);
}
async function gemini(p) {
  for (const m of ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"]) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${process.env.GEMINI_API_KEY}`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: p }] }], generationConfig: { responseMimeType: "application/json" } }) });
    const j = await r.json(); if (r.ok) return JSON.parse(j.candidates[0].content.parts[0].text);
    console.error(m, r.status, ((j.error && j.error.message) || "").slice(0, 120));
  }
  throw new Error("gemini failed");
}
const providers = [];
if (process.env.GITHUB_TOKEN) providers.push(github);
if (process.env.GEMINI_API_KEY) providers.push(gemini);
async function chunk(d, signs) {
  for (const f of providers) {
    try { const o = await f(prompt(d, signs)); if (signs.every(s => o[s] && o[s].love && o[s].work)) return o; console.error("incomplete answer"); }
    catch (e) { console.error(String(e.message || e)); }
  }
  return {};
}
(async () => {
  const out = {};
  for (const d of dates) { out[d] = {}; for (const part of [SIGNS.slice(0, 6), SIGNS.slice(6)]) Object.assign(out[d], await chunk(d, part)); }
  const got = dates.reduce((n, d) => n + Object.keys(out[d]).length, 0);
  console.log("signs written:", got, "of", dates.length * 12);
  if (!got) process.exit(1);
  let old = {}; try { old = JSON.parse(fs.readFileSync("daily.json", "utf8")); } catch (e) {}
  const keep = {}; for (const k of Object.keys(old)) if (k >= day(-2) && !out[k]) keep[k] = old[k];
  fs.writeFileSync("daily.json", JSON.stringify({ ...keep, ...out }));
})();
