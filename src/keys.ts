// meridian — local API-key store. Bun + zero deps.
//
// Keys entered through the Keys screen are persisted in data/keys.json
// (gitignored, never committed). Resolution order for every key:
//   1. the env var, if set (existing setups keep working);
//   2. the key stored through the Keys screen;
//   3. none.
// The full key value is never returned to the browser — only a masked form.

import { mkdirSync, readFileSync, writeFileSync } from "fs";

const DIR = new URL("../data/", import.meta.url).pathname;
const PATH = DIR + "keys.json";

export interface KeyDef {
  id: string;          // env var name, e.g. "OCCRP_API_KEY"
  name: string;        // display name, e.g. "OCCRP Aleph"
  required: boolean;   // true = the source stays idle without a key
  benefit: string;     // what the key unlocks
  signup: string;      // where to get one
  signupLabel: string; // link text
}

export const KEY_DEFS: KeyDef[] = [
  {
    id: "OCCRP_API_KEY",
    name: "OCCRP Aleph",
    required: true,
    benefit: "activates the Investigations source — entity search across 300+ investigative datasets",
    signup: "https://data.occrp.org",
    signupLabel: "free account at data.occrp.org",
  },
  {
    id: "OPENFEC_API_KEY",
    name: "OpenFEC",
    required: false,
    benefit: "raises the campaign-finance quota from 30 requests/hour to 1,000/hour",
    signup: "https://api.open.fec.gov/developers",
    signupLabel: "free personal key at api.open.fec.gov",
  },
  {
    id: "WIGLE_API_KEY",
    name: "WiGLE",
    required: true,
    benefit: "activates the wireless-networks source — wardriven Wi-Fi networks (SSID/BSSID locations) inside the recon area",
    signup: "https://wigle.net/account",
    signupLabel: "free API name + token at wigle.net/account (store as ApiName:ApiToken)",
  },
  {
    id: "EXA_API_KEY",
    name: "Exa",
    required: true,
    benefit: "activates the Exa web-search source — keyword web search across news, people, companies and blogs (~1,000 searches/month free tier)",
    signup: "https://dashboard.exa.ai/",
    signupLabel: "free key at dashboard.exa.ai",
  },
];

let cache: Record<string, string> | null = null;

function load(): Record<string, string> {
  if (cache) return cache;
  mkdirSync(DIR, { recursive: true });
  try {
    const raw = JSON.parse(readFileSync(PATH, "utf8"));
    cache = raw && typeof raw === "object" ? raw : {};
  } catch {
    cache = {};
  }
  return cache;
}

function save(): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(PATH, JSON.stringify(load(), null, 2) + "\n", { mode: 0o600 });
}

export function keySource(id: string): "env" | "stored" | "none" {
  if ((process.env[id] || "").trim()) return "env";
  if ((load()[id] || "").trim()) return "stored";
  return "none";
}

export function resolveKey(id: string): string {
  const env = (process.env[id] || "").trim();
  if (env) return env;
  return (load()[id] || "").trim();
}

export function maskedKey(id: string): string {
  const v = resolveKey(id);
  if (!v) return "";
  if (v.length <= 4) return "••••";
  return "••••" + v.slice(-4);
}

export function storeKey(id: string, value: string): void {
  load()[id] = value;
  save();
}

export function clearStoredKey(id: string): void {
  delete load()[id];
  save();
}

export interface KeyStatus extends KeyDef {
  via: "env" | "stored" | "none";
  configured: boolean;
  masked: string;
}

export function keyStatuses(): KeyStatus[] {
  return KEY_DEFS.map((d) => {
    const via = keySource(d.id);
    return { ...d, via, configured: via !== "none", masked: maskedKey(d.id) };
  });
}
