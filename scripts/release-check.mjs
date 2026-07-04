#!/usr/bin/env node
/**
 * Release gate — the same checks run locally and in CI, so a release
 * can't pass on your machine and fail on the runner (or vice versa).
 *
 * Modes:
 *   node scripts/release-check.mjs              # manifests agree + changelog entry
 *   node scripts/release-check.mjs v0.2.0       # CI tag push: tag must equal manifests
 *   node scripts/release-check.mjs --pre-tag    # local, before tagging: also requires
 *                                               # a clean tree and that the tag is free
 *
 * Why it exists: the updater feed (latest.json) advertises the version
 * baked into tauri.conf.json. If a v0.2.0 tag ships binaries that still
 * say 0.1.0, every installed app sees "no update" forever — the chain
 * is silently broken. Cheaper to fail in 15 seconds than to burn three
 * runner-builds discovering it.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const failures = [];
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => {
  failures.push(msg);
  console.error(`  ✗ ${msg}`);
};

// ── Collect the three versions ──────────────────────────────────────
const pkgVersion = JSON.parse(read("package.json")).version;
const confVersion = JSON.parse(read("src-tauri/tauri.conf.json")).version;

// Cargo.toml isn't JSON — take the first `version = "…"` inside the
// [package] section (it always leads the file; the [dependencies]
// section never uses a bare `version =` line at column 0).
const cargoMatch = read("src-tauri/Cargo.toml").match(
  /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/ms,
);
const cargoVersion = cargoMatch?.[1];

console.log(`release-check  package.json=${pkgVersion}  Cargo.toml=${cargoVersion}  tauri.conf.json=${confVersion}`);

// ── 1. Manifests agree ──────────────────────────────────────────────
if (pkgVersion && pkgVersion === confVersion && pkgVersion === cargoVersion) {
  ok(`all three manifests say ${pkgVersion}`);
} else {
  bad(
    `version mismatch — package.json=${pkgVersion}, src-tauri/Cargo.toml=${cargoVersion}, src-tauri/tauri.conf.json=${confVersion} (bump all three together)`,
  );
}

// ── 2. Changelog has an entry for this version ──────────────────────
if (read("CHANGELOG.md").includes(`## [${pkgVersion}]`)) {
  ok(`CHANGELOG.md has a "## [${pkgVersion}]" section`);
} else {
  bad(`CHANGELOG.md is missing a "## [${pkgVersion}]" section`);
}

// ── 3. Mode-specific checks ─────────────────────────────────────────
const arg = process.argv[2] ?? "";

if (arg === "--pre-tag") {
  // About to cut a tag from this machine: the tree must be committed
  // (the tag should point at what you tested) and the tag still free.
  const dirty = execSync("git status --porcelain", { cwd: root })
    .toString()
    .trim();
  if (dirty) {
    bad(`working tree is dirty (${dirty.split("\n").length} paths) — commit before tagging`);
  } else {
    ok("working tree is clean");
  }

  const tag = `v${pkgVersion}`;
  let exists = true;
  try {
    execSync(`git rev-parse -q --verify refs/tags/${tag}`, {
      cwd: root,
      stdio: "pipe",
    });
  } catch {
    exists = false;
  }
  if (exists) {
    bad(`tag ${tag} already exists — bump the version first`);
  } else {
    ok(`tag ${tag} is free`);
  }
} else if (arg) {
  // CI tag push: refs/tags/v0.2.0 → the tag IS the public version.
  const tagVersion = arg.replace(/^refs\/tags\//, "").replace(/^v/, "");
  if (tagVersion === pkgVersion) {
    ok(`tag matches the manifests (${tagVersion})`);
  } else {
    bad(`tag says ${tagVersion} but the manifests say ${pkgVersion}`);
  }
}

if (failures.length > 0) {
  console.error(`\nrelease-check failed (${failures.length} problem${failures.length > 1 ? "s" : ""}).`);
  process.exit(1);
}
console.log("\nrelease-check passed.");
