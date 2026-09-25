import { matches } from "/Users/lanws/workspace/deepseek-harness-plugins/dsh-ledger-compact/bench/match.mjs";
import { shapeIngress, encodeIngressPng } from "/Users/lanws/workspace/deepseek-harness-plugins/dsh-ledger-compact/lib/ingress.js";

const KEY = process.env.GW_KEY;
const MODEL = process.env.MODEL || "opencode/dyn-deepseek-v4.1-flash";
const HDR = { "content-type": "application/json", authorization: "Bearer " + KEY, "x-opencode-session": "ledger-probe-2" };
const MODES = ["imageOnly", "excerptOnly", "withExcerpt"];
const NL = String.fromCharCode(10);

// 合成语料：摘录窗口(头16行+尾8行)之外、画布(39行)之内放一个独特标记
const lines = [];
for (let i = 1; i <= 3000; i++) {
  lines.push(i === 25 ? "TARGET alpha-7731" : "row " + i + " v" + ((i * 7) % 997));
}
const text = lines.join(NL);

const QA = [
  { q: "What is the exact text written on source line 25? Answer with that line only.", a: "TARGET alpha-7731", zone: "摘录窗口外 / 画布内" },
  { q: "What is the exact text written on source line 5? Answer with that line only.", a: "row 5 v35", zone: "摘录窗口内（对照组）" }
];

async function ask(pngB64, textPart, q, withImage) {
  const content = [];
  if (textPart) content.push({ type: "text", text: textPart });
  if (withImage) content.push({ type: "image_url", image_url: { url: "data:image/png;base64," + pngB64 } });
  content.push({ type: "text", text: q });
  const res = await fetch("http://127.0.0.1:4000/v1/chat/completions", {
    method: "POST", headers: HDR,
    body: JSON.stringify({ model: MODEL, max_tokens: 8000, temperature: 0, messages: [{ role: "user", content }] })
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json();
  const ch = j.choices?.[0] ?? {};
  return { txt: String(ch.message?.content ?? "").trim(), fin: ch.finish_reason };
}

const shaped = shapeIngress(text, { vision: true, model: "deepseek-flash", minSnapTokens: 100 });
console.log("画布:", shaped.text.split(NL)[0]);
const head = shaped.text.split(NL).slice(1, 18).join(NL);
console.log("摘录里能看到 TARGET 吗:", head.includes("TARGET"), "| 能看到 row 5 吗:", head.includes("row 5 v35"));
const b64 = Buffer.from(encodeIngressPng(shaped)).toString("base64");

const stats = {};
for (const m of MODES) stats[m] = { n: 0, ok: 0 };
for (const qa of QA) {
  console.log("--- " + qa.zone + " | 期望 " + qa.a + " ---");
  for (const m of MODES) {
    const withImage = m !== "excerptOnly";
    const textPart = m === "imageOnly" ? "" : shaped.text;
    let r = { txt: "", fin: "?" };
    try { r = await ask(b64, textPart, qa.q, withImage); } catch (e) { r = { txt: "ERR", fin: "err" }; }
    const ok = matches(r.txt, qa.a);
    stats[m].n += 1; if (ok) stats[m].ok += 1;
    console.log("  [" + m.padEnd(12) + "] " + (ok ? "OK  " : "MISS") + " 得=" + JSON.stringify(r.txt.slice(0, 45)) + " fin=" + r.fin);
  }
}
console.log("=== 汇总 ===");
for (const m of MODES) console.log(m + ": " + stats[m].ok + "/" + stats[m].n);