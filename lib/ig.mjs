// Instagram client for the publisher. SECRETS RULE: the token is only ever sent to graph.instagram.com (Authorization header), never printed;
// every message that may contain a secret goes through redact(). In GitHub Actions the secrets come from env vars (IG_ACCESS_TOKEN, IG_USER_ID).
import fs from "node:fs";

export function loadEnvFile(file) {
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

export function makeRedactor(env) {
  return (text) => {
    let s = String(text);
    for (const k of ["IG_ACCESS_TOKEN", "IG_APP_SECRET", "IG_APP_ID", "IG_USER_ID"]) if (env[k] && env[k].length > 3) s = s.split(env[k]).join(`<${k}>`);
    return s.replace(/IG[A-Za-z0-9_-]{30,}/g, "<token>").replace(/access_token=[^&\s"]+/g, "access_token=<redacted>").replace(/"id":"?\d{8,}"?/g, '"id":"<id>"');
  };
}

async function call(env, method, pathAndQuery, params) {
  const res = await fetch(`https://graph.instagram.com/${pathAndQuery}`, {
    method,
    headers: { Authorization: `Bearer ${env.IG_ACCESS_TOKEN}`, ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { ok: res.ok, status: res.status, json };
}

export function realClient(env) {
  return { userId: env.IG_USER_ID, get: (p) => call(env, "GET", p), post: (p, params) => call(env, "POST", p, params) };
}

// In-memory fake Instagram for tests: records every call; behaviour can be tuned with options.
export function mockClient(opts = {}) {
  const calls = [];
  let n = 0;
  const log = (c) => { calls.push(c); if (process.env.IGMOCK_LOG) fs.appendFileSync(process.env.IGMOCK_LOG, JSON.stringify(c) + "\n"); };
  return {
    userId: "MOCKUSER",
    calls,
    async get(p) {
      log(["GET", p]);
      if (p.startsWith("me/media")) return { ok: true, status: 200, json: { data: opts.existingPosts || [] } };
      if (p.includes("fields=status_code")) return { ok: true, status: 200, json: { status_code: opts.statusCode || "FINISHED" } };
      if (p.includes("fields=media_type")) return { ok: true, status: 200, json: { media_type: "CAROUSEL_ALBUM", timestamp: "2026-10-08T12:00:00+0000", permalink: "https://www.instagram.com/p/MOCK/", children: { data: Array.from({ length: opts.childrenCount ?? 7 }, () => ({ media_type: "IMAGE" })) } } };
      return { ok: true, status: 200, json: {} };
    },
    async post(p, params) {
      log(["POST", p, params]);
      if (opts.failChildAt && p.endsWith("/media") && params.is_carousel_item && calls.filter((c) => c[0] === "POST" && c[2]?.is_carousel_item).length === opts.failChildAt) return { ok: false, status: 500, json: { error: { message: "mock failure", code: 1 } } };
      if (p.endsWith("/media_publish")) return { ok: true, status: 200, json: { id: "MOCKMEDIA" } };
      return { ok: true, status: 200, json: { id: `C${++n}` } };
    },
  };
}
