import { fixtures } from "/Users/lanws/workspace/deepseek-harness-plugins/dsh-ledger-compact/bench/fixtures.mjs";
import { matches } from "/Users/lanws/workspace/deepseek-harness-plugins/dsh-ledger-compact/bench/match.mjs";
import { shapeIngress, encodeIngressPng } from "/Users/lanws/workspace/deepseek-harness-plugins/dsh-ledger-compact/lib/ingress.js";

const KEY = process.env.GW_KEY;
const MODEL = process.env.MODEL || "opencode/dyn-deepseek-v4.1-flash";
const HDR = { "content-type": "application/json", authorization: "Bearer " + KEY, "x-opencode-session": "ledger-fid-3" };
const MODES = (process.env.MODES || "imageOnly,withExcerpt").split(",");
const NL = String.fromCharCode(10);

async function ask(pngB64, textPart, q, withImage) {
  const content = [];
  if (textPart) content.push({ type: "text", text: textPart });
  if (withImage) content.push({ type: "image_url", image_url: { url: "data:image/png;base64," + pngB64 } });
  content.push({ type: "text", text: q });
  const res = await fetch("http://127.0.0.1:4000/v1/chat/completions", {
    method: "POST", headers: HDR,
    body: JSON.stringify({ model: MODEL, max_tokens: 8000, temperature: 0, messages: [{ role: "user", content }] })
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 120));
  const j = await res.json();
  const ch = j.choices?.[0] ?? {};
  return { txt: String(ch.message?.content ?? "").trim(), fin: ch.finish_reason, rtok: j.usage?.completion_tokens ?? 0 };
}

const stats = {};
for (const m of MODES) stats[m] = { n: 0, ok: 0, trunc: 0, okClean: 0, nClean: 0 };
for (const f of fixtures()) {
  const shaped = shapeIngress(f.lines.join(NL), { vision: true, model: "deepseek-flash", minSnapTokens: 100 });
  if (!shaped.snapped) { console.log("跳过 " + f.name + "（不贴图）"); continue; }
  const b64 = Buffer.from(encodeIngressPng(shaped)).toString("base64");
  for (const qa of f.qa) {
    for (const m of MODES) {
      const withImage = m !== "excerptOnly";
      const textPart = m === "imageOnly" ? "" : shaped.text;
      let r = { txt: "", fin: "?", rtok: 0 };
      try { r = await ask(b64, textPart, qa.q, withImage); } catch (e) { r = { txt: "ERR", fin: "err", rtok: 0 }; }
      const ok = matches(r.txt, qa.a);
      const s = stats[m];
      s.n += 1; if (ok) s.ok += 1;
      if (r.fin === "length") s.trunc += 1; else { s.nClean += 1; if (ok) s.okClean += 1; }
      console.log(" [" + m.padEnd(12) + "] " + (ok ? "OK  " : "MISS") + " " + f.name + " 期望=" + qa.a + " 得=" + JSON.stringify(r.txt.slice(0, 40)) + " fin=" + r.fin);
    }
  }
}
console.log("=== 汇总（" + MODEL + "）===");
for (const m of MODES) {
  const s = stats[m];
  console.log(m + ": 全部 " + s.ok + "/" + s.n + " | 截断 " + s.trunc + " | 剔除截断后 " + s.okClean + "/" + s.nClean + (s.nClean ? " = " + (100 * s.okClean / s.nClean).toFixed(0) + "%" : ""));
}