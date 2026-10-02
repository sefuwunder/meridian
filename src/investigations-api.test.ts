// meridian — investigation API over real HTTP. Spawns the server on a temp
// port; creates and deletes its own investigation so the dev data dir is
// left clean. Transform/search paths that need network are covered by the
// stubbed unit tests in transforms.test.ts.

import { test, expect, beforeAll, afterAll } from "bun:test";

const PORT = 31991;
const BASE = `http://127.0.0.1:${PORT}`;
let proc: any = null;

async function api(path: string, opts: any = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${opts.method || "GET"} ${path} → ${r.status}: ${j.error || ""}`);
  return j;
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", "src/server.ts"], {
    env: { ...process.env, PORT: String(PORT) },
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try { await api("/api/entity-types"); return; } catch { await Bun.sleep(200); }
  }
  throw new Error("server did not boot");
});

afterAll(() => { try { proc?.kill(); } catch {} });

test("entity-types + transforms endpoints", async () => {
  const t = await api("/api/entity-types");
  expect(Object.keys(t.types).length).toBe(12);
  const tr = await api("/api/transforms");
  expect(tr.transforms.length).toBe(13);
  expect(tr.transforms.every((x: any) => x.key && x.label && x.inputTypes)).toBe(true);
});

test("investigation lifecycle: create → get → add entity → note → delete", async () => {
  const created = await api("/api/investigations", {
    method: "POST", body: JSON.stringify({ name: "api-test", seedValue: "example.com" }),
  });
  const id = created.investigation.id;
  expect(id).toMatch(/^inv-/);
  expect(created.investigation.entities[0]).toMatchObject({ type: "domain", value: "example.com" });

  const list = await api("/api/investigations");
  expect(list.investigations.some((i: any) => i.id === id)).toBe(true);

  const withIp = await api(`/api/investigations/${id}/entities`, {
    method: "POST", body: JSON.stringify({ type: "ip", value: "1.2.3.4" }),
  });
  expect(withIp.investigation.entities.length).toBe(2);

  // duplicate add is a no-op
  const dup = await api(`/api/investigations/${id}/entities`, {
    method: "POST", body: JSON.stringify({ type: "ip", value: "1.2.3.4" }),
  });
  expect(dup.investigation.entities.length).toBe(2);

  const noted = await api(`/api/investigations/${id}/note`, {
    method: "POST", body: JSON.stringify({ text: "analyst was here", entityId: "ip:1-2-3-4" }),
  });
  const noteEnt = noted.investigation.entities.find((e: any) => e.type === "note");
  expect(noteEnt).toBeTruthy();
  expect(noted.investigation.links.some((l: any) => l.to === noteEnt.id && l.label === "note")).toBe(true);

  await api(`/api/investigations/${id}`, { method: "DELETE" });
  const after = await api("/api/investigations");
  expect(after.investigations.some((i: any) => i.id === id)).toBe(false);
});

test("search: ip auto-detect needs no network", async () => {
  const j = await api("/api/search", { method: "POST", body: JSON.stringify({ query: "9.9.9.9" }) });
  expect(j.type).toBe("ip");
  expect(j.entities[0]).toMatchObject({ type: "ip", value: "9.9.9.9" });
});

test("transform: unknown key → 404, wrong entity type → 400", async () => {
  const created = await api("/api/investigations", {
    method: "POST", body: JSON.stringify({ name: "api-test-2", seedValue: "example.com" }),
  });
  const id = created.investigation.id;
  try {
    await api(`/api/investigations/${id}/transform`, {
      method: "POST", body: JSON.stringify({ entityId: "domain:example-com", transformKey: "nope" }),
    });
    expect("should have thrown").toBe("did not throw");
  } catch (e: any) { expect(e.message).toContain("404"); }
  try {
    await api(`/api/investigations/${id}/transform`, {
      method: "POST", body: JSON.stringify({ entityId: "domain:example-com", transformKey: "ip-ports" }),
    });
    expect("should have thrown").toBe("did not throw");
  } catch (e: any) { expect(e.message).toContain("400"); }
  await api(`/api/investigations/${id}`, { method: "DELETE" });
});
