// Can jq replace sqlite3 for the sams result-filtering path?
//
// Runs, inside the real VM, every operation skills/sams.md currently mandates
// sqlite3 for — plus the "latest row per group" aggregation that crashed the
// VM in a live agent run (a multi-CTE JOIN with json_group_array).
//
// Staging: jq + libonig from the product CDN payload (see poll-sqlite-hang.mjs
// for the same pattern). SQ_DIR must already hold them.
//
//   bun test/debug/jq-vs-sqlite.mjs
import { chromium } from "playwright";
import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 8781;
const SQ = process.env.SQ_DIR || "/tmp/mvl-sq";

const NEED = [
  ["lib/ld-musl-x86_64.so.1", "/lib/ld-musl-x86_64.so.1"],
  ["lib/libc.musl-x86_64.so.1", "/lib/libc.musl-x86_64.so.1"],
  ["usr/lib/libonig.so.5", "/usr/lib/libonig.so.5"],
  ["usr/bin/jq", "/usr/bin/jq"],
];
for (const [rel] of NEED) {
  if (!existsSync(resolve(SQ, rel))) { console.error("missing " + resolve(SQ, rel)); process.exit(2); }
}

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
const cleanup = () => { try { server.kill(); } catch {} };
process.on("exit", cleanup);

let failures = 0;
const check = (n, c, d) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.log(`  ✗ ${n}  — ${d}`); } };

async function waitServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); }
  throw new Error("server never came up");
}
await waitServer(`http://localhost:${PORT}/test/contract.html`);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", e => console.log("[pageerror]", e.message));

// A sams-shaped result: the envelope skills/sams.md describes, with rows that
// have a space in a column name (the thing that produced `near "Limit"` and
// `near "."` SQL syntax errors in the live run) and repeated Site+Contaminant
// pairs across dates (so "latest per group" is a real reduction).
const SAMPLE = {
  success: true, message: "Results retrieved successfully",
  query_title: "Monthly Summary Limit Calcs",
  metadata: { row_count: 6 },
  data: [
    { Site: "A", Contaminant: "Lead",   SampleDate: "2025-03-01", "Limit Value": 10, Result: 4 },
    { Site: "A", Contaminant: "Lead",   SampleDate: "2025-07-01", "Limit Value": 12, Result: 9 },
    { Site: "A", Contaminant: "Copper", SampleDate: "2025-05-01", "Limit Value": 20, Result: 1 },
    { Site: "B", Contaminant: "Lead",   SampleDate: "2025-02-01", "Limit Value": 10, Result: 7 },
    { Site: "B", Contaminant: "Lead",   SampleDate: "2025-06-15", "Limit Value": 11, Result: 2 },
    { Site: "B", Contaminant: "Copper", SampleDate: "2025-06-15", "Limit Value": 20, Result: 3 },
  ],
};

try {
  await page.goto(`http://localhost:${PORT}/test/contract.html`);
  await page.waitForFunction(() => window.__startVM !== undefined, { timeout: 15000 });
  await page.evaluate(() => window.__startVM({ baseEtag: "jq-v1", cdnBase: "/dist", workerUrl: "/src/vm-worker.js", vmRoutes: {} }));
  await page.waitForFunction(() => window.vm && window.vm.isReady === true, { timeout: 45000 });

  for (const [rel, dest] of NEED) {
    const bytes = Array.from(readFileSync(resolve(SQ, rel)));
    await page.evaluate(async ({ dest, bytes }) => window.vm.writeFile(dest, new Uint8Array(bytes), { mode: "0755" }), { dest, bytes });
  }
  await page.evaluate(async (s) => window.vm.writeFile("/tmp/res.json", s), JSON.stringify(SAMPLE));

  const run = (cmd) => page.evaluate((c) => window.vm.execute(c, 30000).catch(e => "ERR:" + e.message), cmd);
  const J = "/usr/bin/jq";

  console.log("\n== jq runs ==");
  check("jq --version", /^jq-/.test(String(await run(`${J} --version 2>&1`)).trim()), await run(`${J} --version 2>&1`));

  console.log("\n== 1. spot-check a scalar (sams.md's sqlite3 json_extract case) ==");
  const ok = String(await run(`${J} -r '.success' /tmp/res.json`)).trim();
  check("read .success", ok === "true", ok);

  console.log("\n== 2. discover column names (SQLiteFilter Step 1) ==");
  const cols = String(await run(`${J} -r '.data[0] | keys_unsorted | join(",")' /tmp/res.json`)).trim();
  check("column discovery incl. spaced name", cols.includes("Limit Value") && cols.includes("Site"), cols);

  console.log("\n== 3. distinct filter values (SQLiteFilter Step 2) ==");
  const distinct = String(await run(`${J} -r '[.data[].Contaminant] | unique | join(",")' /tmp/res.json`)).trim();
  check("distinct values", distinct === "Copper,Lead", distinct);

  console.log("\n== 4. filter + project, incl. a column with a space ==");
  const filtered = String(await run(`${J} -c '[.data[] | select(.Contaminant=="Lead") | {Site, d:.SampleDate, lim:.["Limit Value"]}]' /tmp/res.json`)).trim();
  check("filter on spaced column", filtered.includes('"lim":12') && !filtered.includes("Copper"), filtered);

  console.log("\n== 5. LATEST ROW PER GROUP — the aggregation that crashed sqlite3 ==");
  const latest = String(await run(
    `${J} -c '[.data | group_by(.Site + "|" + .Contaminant)[] | max_by(.SampleDate) | {Site, Contaminant, SampleDate}] | sort_by(.Site,.Contaminant)' /tmp/res.json`)).trim();
  const expect = '[{"Site":"A","Contaminant":"Copper","SampleDate":"2025-05-01"},'
               + '{"Site":"A","Contaminant":"Lead","SampleDate":"2025-07-01"},'
               + '{"Site":"B","Contaminant":"Copper","SampleDate":"2025-06-15"},'
               + '{"Site":"B","Contaminant":"Lead","SampleDate":"2025-06-15"}]';
  check("latest-per-group correct (one jq expression)", latest === expect, latest);

  console.log("\n== 6. rewrap into the final envelope (SQLiteFilter Step 4's json_set) ==");
  const wrapped = String(await run(
    `${J} -c '{success:true, message:"Results retrieved successfully", query_title:.query_title, metadata:{}, ` +
    `data:[.data[] | select(.Site=="A")]}' /tmp/res.json > /tmp/wrapped.json; ` +
    `${J} -r '"\\(.success) \\(.data|length) \\(.query_title)"' /tmp/wrapped.json`)).trim();
  check("rewrap preserves envelope shape", wrapped === "true 3 Monthly Summary Limit Calcs", wrapped);

  console.log("\n== 7. row count without dumping the body ==");
  const n = String(await run(`${J} -r '.data | length' /tmp/res.json`)).trim();
  check("row count", n === "6", n);

  console.log("\n== 8. sams.md Step 4 wrap verbatim (--slurpfile) ==");
  await run(`${J} -c '[.data[] | select(.Site=="A")]' /tmp/res.json > /tmp/rows.json`);
  const slurped = String(await run(
    `${J} -n --slurpfile rows /tmp/rows.json '{success: true, message: "Results retrieved successfully", ` +
    `query_title: "T", metadata: {}, data: $rows[0]}' > /tmp/final.json; ` +
    `${J} -r '"\\(.success) \\(.data|length) \\(.data[0].Site)"' /tmp/final.json`)).trim();
  check("--slurpfile wrap produces valid envelope", slurped === "true 3 A", slurped);

  const alive = String(await run("echo alive")).trim();
  check("VM healthy at end (no crash)", alive === "alive", alive);

} catch (e) { failures++; console.log("FATAL:", e.stack || e.message); }
finally { await browser.close(); cleanup(); }

console.log(failures === 0 ? "\nALL GREEN — jq covers every sqlite3 use in sams.md" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
