// Local tests for publish-queue.mjs with a MOCK Instagram (no network, no secrets):  bun test/run-tests.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "publish-queue.mjs");
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ✓", msg); } else { fail++; console.log("  ✗ FAIL:", msg); } };

function makeQueue(items) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "igq-"));
  const q = path.join(dir, "queue");
  for (const it of items) {
    const d = path.join(q, it.id);
    fs.mkdirSync(d, { recursive: true });
    for (let i = 1; i <= (it.n ?? 7); i++) fs.writeFileSync(path.join(d, String(i).padStart(2, "0") + ".jpg"), "x");
    fs.writeFileSync(path.join(d, "caption.txt"), it.caption ?? "שורה ראשונה של הכיתוב.\nשורה שנייה של הכיתוב.\n");
    fs.writeFileSync(path.join(d, "meta.json"), JSON.stringify({ publish_at: it.at, approved_by_amit: it.approved ?? true, status: it.status ?? "pending" }, null, 2));
  }
  return { dir, q };
}
function run(q, nowIso, opts = {}, extra = []) {
  const log = path.join(path.dirname(q), "calls.log");
  fs.writeFileSync(log, "");
  const r = spawnSync("bun", [SCRIPT, "--queue", q, "--now", nowIso, "--mock", "--base-url", "https://example.test/repo", ...extra], { env: { ...process.env, IGMOCK_LOG: log, IGMOCK_OPTS: JSON.stringify(opts) }, encoding: "utf8" });
  const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { code: r.status, out: r.stdout + r.stderr, calls };
}
const meta = (q, id) => JSON.parse(fs.readFileSync(path.join(q, id, "meta.json"), "utf8"));
const publishes = (calls) => calls.filter((c) => c[0] === "POST" && c[1].endsWith("/media_publish")).length;

console.log("1) a future item is left alone");
{ const { q } = makeQueue([{ id: "a", at: "2026-10-08T15:00:00+03:00" }]);
  const r = run(q, "2026-10-08T14:00:00+03:00");
  ok(r.code === 0 && publishes(r.calls) === 0 && r.calls.length === 0 && meta(q, "a").status === "pending", "no calls, still pending"); }

console.log("2) a due item is published once, in order, then cleaned");
{ const { q } = makeQueue([{ id: "b", at: "2026-10-08T15:00:00+03:00" }]);
  const r = run(q, "2026-10-08T15:07:00+03:00");
  const kids = r.calls.filter((c) => c[0] === "POST" && c[2]?.is_carousel_item);
  ok(r.code === 0 && publishes(r.calls) === 1, "exactly one media_publish");
  ok(kids.length === 7 && kids.every((c, i) => c[2].image_url.endsWith(`/queue/b/${String(i + 1).padStart(2, "0")}.jpg`)), "7 children created in file order 01..07 with the raw URLs");
  const parent = r.calls.find((c) => c[0] === "POST" && c[2]?.media_type === "CAROUSEL");
  ok(parent && parent[2].children.split(",").length === 7 && parent[2].caption.split("\n").length === 2, "carousel container has 7 children and the 2-line caption");
  const m = meta(q, "b");
  ok(m.status === "published" && m.permalink && m.published_at, "meta marked published with permalink");
  ok(!fs.existsSync(path.join(q, "b", "01.jpg")) && !fs.existsSync(path.join(q, "b", "caption.txt")), "images and caption removed from the working tree"); }

console.log("3) a second run does not publish again");
{ const { q } = makeQueue([{ id: "c", at: "2026-10-08T15:00:00+03:00" }]);
  run(q, "2026-10-08T15:05:00+03:00");
  const r2 = run(q, "2026-10-08T15:15:00+03:00");
  ok(r2.code === 0 && r2.calls.length === 0, "status published -> no calls at all"); }

console.log("4) too late (>6 h) is NOT published and fails loudly");
{ const { q } = makeQueue([{ id: "d", at: "2026-10-08T15:00:00+03:00" }]);
  const r = run(q, "2026-10-08T22:30:00+03:00");
  ok(r.code === 1 && publishes(r.calls) === 0 && meta(q, "d").status === "late", "exit 1, status late, nothing posted"); }

console.log("5) not approved by Amit -> never published");
{ const { q } = makeQueue([{ id: "e", at: "2026-10-08T15:00:00+03:00", approved: false }]);
  const r = run(q, "2026-10-08T16:00:00+03:00");
  ok(r.code === 0 && r.calls.length === 0 && meta(q, "e").status === "pending", "skipped, still pending"); }

console.log("6) duplicate protection: an existing post with the same caption is adopted");
{ const { q } = makeQueue([{ id: "f", at: "2026-10-08T15:00:00+03:00" }]);
  const r = run(q, "2026-10-08T15:20:00+03:00", { existingPosts: [{ caption: "שורה ראשונה של הכיתוב.\nשורה שנייה של הכיתוב.", timestamp: "2026-10-08T12:02:00+0000", permalink: "https://www.instagram.com/p/EXISTING/" }] });
  ok(r.code === 0 && publishes(r.calls) === 0 && meta(q, "f").status === "published" && /EXISTING/.test(meta(q, "f").permalink), "no new post, marked published with the existing link"); }

console.log("7) a failing child stops everything before media_publish");
{ const { q } = makeQueue([{ id: "g", at: "2026-10-08T15:00:00+03:00" }]);
  const r = run(q, "2026-10-08T15:05:00+03:00", { failChildAt: 3 });
  ok(r.code === 1 && publishes(r.calls) === 0 && meta(q, "g").status === "failed" && /mock failure/.test(meta(q, "g").error), "exit 1, status failed, error recorded, nothing published"); }

console.log("8) several items: only the due one goes");
{ const { q } = makeQueue([{ id: "h1", at: "2026-10-08T15:00:00+03:00" }, { id: "h2", at: "2026-10-09T09:00:00+03:00" }]);
  const r = run(q, "2026-10-08T15:30:00+03:00");
  ok(publishes(r.calls) === 1 && meta(q, "h1").status === "published" && meta(q, "h2").status === "pending", "h1 published, h2 still pending"); }

console.log("9) bad image count is rejected");
{ const { q } = makeQueue([{ id: "i", at: "2026-10-08T15:00:00+03:00", n: 1 }]);
  const r = run(q, "2026-10-08T15:05:00+03:00");
  ok(r.code === 1 && publishes(r.calls) === 0 && meta(q, "i").status === "failed", "1 image -> failed, nothing published"); }

console.log("10) --dry-run builds the containers but never publishes and changes nothing");
{ const { q } = makeQueue([{ id: "j", at: "2026-10-08T15:00:00+03:00" }]);
  const r = run(q, "2026-10-08T15:05:00+03:00", {}, ["--dry-run"]);
  ok(r.code === 0 && publishes(r.calls) === 0 && r.calls.some((c) => c[2]?.media_type === "CAROUSEL"), "carousel container created, no media_publish");
  ok(meta(q, "j").status === "pending" && fs.existsSync(path.join(q, "j", "01.jpg")), "still pending, images kept"); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
