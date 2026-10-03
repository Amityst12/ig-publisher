// Publishes the DUE items of queue/ to Instagram. Runs in GitHub Actions every ~10 min (or locally with --mock / --env-file for tests).
//   bun scripts/publish-queue.mjs [--queue queue] [--now <ISO>] [--mock] [--env-file <path>] [--base-url <url>] [--max-late-hours 6]
// queue/<id>/: 01.jpg … NN.jpg (1080x1350), caption.txt (exactly 2 lines), meta.json {publish_at, approved_by_amit, status}
// Rules: only status=pending + approved_by_amit=true + publish_at<=now; never posts more than max-late-hours after its time (marks it "late", exit 1);
// idempotent (adopts an already-published post with the same caption first line); after success deletes the images (history keeps them, harmless: they are public on Instagram).
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile, makeRedactor, realClient, mockClient } from "../lib/ig.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf("--" + k); return i < 0 ? d : argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true; };
const queueDir = path.resolve(arg("queue", "queue"));
const now = arg("now") ? new Date(arg("now")) : new Date();
const maxLateMs = Number(arg("max-late-hours", 6)) * 3600 * 1000;
const env = { ...(arg("env-file") ? loadEnvFile(arg("env-file")) : {}), ...Object.fromEntries(["IG_ACCESS_TOKEN", "IG_USER_ID"].filter((k) => process.env[k]).map((k) => [k, process.env[k]])) };
const redact = makeRedactor(env);
const client = arg("mock") ? mockClient(JSON.parse(process.env.IGMOCK_OPTS || "{}")) : realClient(env);
if (!arg("mock") && (!env.IG_ACCESS_TOKEN || !env.IG_USER_ID)) { console.error("missing IG_ACCESS_TOKEN / IG_USER_ID (secrets)"); process.exit(1); }
const repo = process.env.GITHUB_REPOSITORY || "OWNER/REPO";
const branch = process.env.GITHUB_REF_NAME || "main";
const baseUrl = arg("base-url", `https://raw.githubusercontent.com/${repo}/${branch}`);
const dryRun = !!arg("dry-run");
const sleep = (ms) => new Promise((r) => setTimeout(r, arg("mock") ? 0 : ms));

async function waitFinished(id) {
  for (let i = 0; i < 40; i++) {
    const r = await client.get(`${id}?fields=status_code,status`);
    const code = r.json.status_code;
    if (code === "FINISHED") return;
    if (code === "ERROR" || code === "EXPIRED") throw new Error(`container ${code}: ${redact(JSON.stringify(r.json))}`);
    await sleep(2000);
  }
  throw new Error("container did not finish in time");
}

async function publishItem(id, dir, meta) {
  const files = fs.readdirSync(dir).filter((f) => /^\d{2}\.jpg$/i.test(f)).sort();
  if (files.length < 2 || files.length > 10) throw new Error(`need 2-10 JPEGs, found ${files.length}`);
  const caption = fs.readFileSync(path.join(dir, "caption.txt"), "utf8").trim();
  const firstLine = caption.split(/\r?\n/)[0].trim();
  // idempotency: was it already published (e.g. a previous run crashed after media_publish)?
  const recent = await client.get("me/media?fields=caption,timestamp,permalink&limit=15");
  const dup = (recent.json.data || []).find((m) => (m.caption || "").split(/\r?\n/)[0].trim() === firstLine && new Date(m.timestamp) >= new Date(new Date(meta.publish_at).getTime() - 86400000));
  if (dup) return { adopted: true, permalink: dup.permalink };
  const children = [];
  for (const f of files) {
    const r = await client.post(`${client.userId}/media`, { image_url: `${baseUrl}/queue/${id}/${f}`, is_carousel_item: "true" });
    if (!r.ok) throw new Error(`child ${f} failed: ${redact(JSON.stringify(r.json))}`);
    await waitFinished(r.json.id);
    children.push(r.json.id);
  }
  const parent = await client.post(`${client.userId}/media`, { media_type: "CAROUSEL", children: children.join(","), caption });
  if (!parent.ok) throw new Error(`carousel container failed: ${redact(JSON.stringify(parent.json))}`);
  await waitFinished(parent.json.id);
  if (dryRun) return { dry: true };
  const pub = await client.post(`${client.userId}/media_publish`, { creation_id: parent.json.id });
  if (!pub.ok) throw new Error(`media_publish failed: ${redact(JSON.stringify(pub.json))}`);
  const v = await client.get(`${pub.json.id}?fields=media_type,timestamp,permalink,children{media_type}`);
  const kids = (v.json.children && v.json.children.data) || [];
  if (kids.length !== files.length) console.log(`WARNING: published ${kids.length}/${files.length} items — check the post`);
  return { permalink: v.json.permalink, items: kids.length };
}

let failures = 0;
if (!fs.existsSync(queueDir)) { console.log("no queue dir"); process.exit(0); }
for (const id of fs.readdirSync(queueDir).sort()) {
  const dir = path.join(queueDir, id);
  const metaPath = path.join(dir, "meta.json");
  if (!fs.statSync(dir).isDirectory() || !fs.existsSync(metaPath)) continue;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  if (meta.status !== "pending") { continue; }
  if (meta.approved_by_amit !== true) { console.log(`${id}: not approved by Amit -> skipped`); continue; }
  const at = new Date(meta.publish_at);
  if (isNaN(at)) { console.log(`${id}: bad publish_at`); failures++; continue; }
  if (now < at) { console.log(`${id}: waiting until ${meta.publish_at}`); continue; }
  const save = () => fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  if (now - at > maxLateMs) { meta.status = "late"; meta.note = `not published: ${Math.round((now - at) / 3600000)} h after the scheduled time`; save(); console.log(`${id}: LATE -> not published`); failures++; continue; }
  try {
    console.log(`${id}: publishing…`);
    const r = await publishItem(id, dir, meta);
    if (r.dry) { console.log(`${id}: DRY RUN OK — containers created and FINISHED, nothing published, nothing changed`); continue; }
    meta.status = "published"; meta.published_at = now.toISOString(); meta.permalink = r.permalink; if (r.adopted) meta.note = "adopted an existing post (no duplicate created)";
    save();
    for (const f of fs.readdirSync(dir)) if (/^\d{2}\.jpg$/i.test(f) || f === "caption.txt") fs.rmSync(path.join(dir, f));
    console.log(`${id}: PUBLISHED ${r.permalink || ""} (images removed from the working tree)`);
  } catch (e) {
    meta.status = "failed"; meta.error = redact(e.message).slice(0, 500); save();
    console.log(`${id}: FAILED -> ${meta.error}`); failures++;
  }
}
process.exit(failures ? 1 : 0);
