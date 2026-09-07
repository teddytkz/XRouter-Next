# PRD: XRouter-Next = Next + 9Router Extended (merge)

**Status (2026-09-07):** FASE 0–7 ✅ selesai. FASE 8 (build & verify) ⏳ next.

| FASE | Deskripsi | Commit | Status |
|---|---|---|---|
| 0 | Rebrand ke XRouter-Next (keep `~/.9router/` data path) | `e68f5ec4` | ✅ |
| 1 | Freebuff provider (executor, registry, oauth, usage) | `bccd415f` | ✅ |
| 2 | Routing health/probe/ranking + combos/suggest + latency-stream | `3a75e498` | ✅ |
| 3 | Hermes plugin subsystem (7 lib + 9 API + session cache + update-check) | (lanjutan) | ✅ |
| 4 | Skills registry + 14 skill packs + autoRouter/localSkillRouter/tfidf | (lanjutan) | ✅ |
| 5 | Autostart + version + setup wizard + tunnel/pxpipe update | `2b29d6a7` | ✅ |
| 6 | Test suite porting (15 unit + mem-budget + snapshot) | `e967dc89` | ✅ |
| 7 | opencode-go regresi guard (5 file + 5 test files intact) | verification-only | ✅ |
| 8 | `npm install` + `npm run build` + smoke test | — | ⏳ |

**Branch base:** `next` (XRouter-Next v0.5.69) — **lebih baru** dari `origin/master`, jadi dipakai sebagai base.
**Branch sumber:** `origin/fixing-cli-token` (= `extended` HEAD, v0.5.65-extended).
**Tujuan:** gabungkan SEMUA fitur extended ke `next`, tanpa kehilangan fitur `next` (opencode-go, Muse Spark, Claude Fable, Antigravity quota group, dsb).

## Strategi merge (3-way, bukan overwrite)

```
            90b52e06 (merge base)
           /                  \
     master/next (+31)      extended (+107)
           \                  /
            \                /
             TARGET = next
```

- 162 file modified → di-merge per file, bukan di-overwrite
- 53 file extended-only src → di-port apa adanya
- 7 file extended-only open-sse → di-port + registrasi di `index.js`
- 594 file skills → copy massal (zero conflict)
- 18 file tests extended → di-port + di-render dependensi yang hilang

## Konvensi PRD

- `[ ]` = belum mulai
- `[~]` = in progress
- `[x]` = selesai & diverifikasi
- Setiap item menunjuk ke: `src file target ← source: extended path`
- Verifikasi = `npm run build` + `cd tests && npx vitest run unit/<test>.js` (kecuali feature yang perlu runtime)

---

## FASE 0 — Rename project (zero risk, isolated)

Branch feature: `rename/xrouter-next` → merge ke `next` setelah clean.

- [ ] **`package.json`** rename `name` `9router-app` → `xrouter-next` (root)
- [ ] **`package.json`** scripts: `dev` port 20127 → 20128 (opsional, sesuai CLAUDE.md)
- [ ] **`cli/package.json`** rename `name` `9router` → `xrouter` + binary `9router` → `xrouter`
- [ ] **`cli/cli.js`** update banner, command name, help text
- [ ] **`README.md`** + **`README.zh-CN.md`** ganti brand string (heading, badges, install command)
- [ ] **`next.config.mjs`** update `appName` kalau ada
- [ ] **`custom-server.js`** update server title
- [ ] **JANGAN rename** yang破坏 kompatibilitas:
  - path `~/.9router/` (user data) — keep, atau sediakan migration shim
  - DB key namespace `9router:` (kalau ada)
  - npm package `9router` di registry cli — decide upstream vs fork

**Verify:** `npm run build` sukses, `node custom-server.js` start di port baru, dashboard load.

---

## FASE 1 — Provider: freebuff (4 file, low conflict)

Source baru, tidak ada di `next`. Tambah langsung.

- [ ] `open-sse/executors/freebuff.js` (copas, register di `open-sse/executors/index.js`)
- [ ] `open-sse/providers/registry/freebuff.js` (copas, regenerate `registry/index.js` via `scripts/injectDisplayToRegistry.mjs`)
- [ ] `open-sse/services/usage/freebuff.js` (copas, register di `open-sse/services/usage.js` kalau ada map)
- [ ] `open-sse/config/providerModels.js` append `freebuff` model list (merge, jangan timpa yang sudah ada di `next`)
- [ ] `public/providers/freebuff.png` (asset)
- [ ] `src/lib/oauth/providers/freebuff.js` (device code flow)
- [ ] `open-sse/providers/registry/index.js` regenerate

**Verify:** `npx vitest run unit/freebuff-strict-model-assignment.test.js` (perlu di-port dulu di FASE 6).

---

## FASE 2 — Routing health & model probing (3 file src + open-sse)

- [ ] `src/lib/routing/health.js` (EMA latency, circuit breaker, diagnostic hints)
- [ ] `src/lib/routing/modelProbe.js` (minimal-token probe, search-cap detect, 10s timeout, non-LLM filter)
- [ ] `src/lib/routing/modelRanking.js` (ranked auto-combo suggestions)
- [ ] `src/lib/proxy/diagnostics.js` (proxy diagnostics helper)
- [ ] `src/lib/db/repos/proxyPoolFitnessRepo.js` + `open-sse/services/proxyPoolFitness.js` (fitness store)
- [ ] Wire `modelProbe` ke `/v1/models` resolution di `open-sse/handlers/chatCore.js` — **3-way merge dengan versi next** (next punya flow sendiri di sini, jangan timpa)
- [ ] UI: `src/app/(dashboard)/dashboard/providers/components/RoutingHealthMonitor.js` (component baru)
- [ ] UI: `src/app/(dashboard)/dashboard/providers/[id]/FetchOpenRouterModelsModal.js` (modal baru)
- [ ] API: `src/app/api/usage/active-providers/route.js` (next yang punya versi 0.5.66 → **bandingkan** sebelum port)
- [ ] API: `src/app/api/health/latency-stream/route.js` (SSE stream)
- [ ] API: `src/app/api/combos/suggest/route.js` + `accept/route.js` (suggest + accept flow)
- [ ] Fix `usage` page: `activeProviders selalu 0` — `src/app/(dashboard)/dashboard/usage/page.js` (merge: keep next + add extended fix `1fc07408`)

**Verify:** `npx vitest run unit/diagnostics.test.js unit/model-probe-suggest.test.js unit/health-and-session.test.js`

---

## FASE 3 — Hermes Agent plugin (lifecycle + memory + telegram + extraction)

Suite besar. Spec lengkap di `docs/superpowers/specs/2026-09-04-opencode-go-session-header-design.md` (sebagai referensi style).

- [ ] `src/lib/plugins/hermes/paths.js` (filesystem layout)
- [ ] `src/lib/plugins/hermes/detect.js` (detect install)
- [ ] `src/lib/plugins/hermes/install.js` (install)
- [ ] `src/lib/plugins/hermes/process.js` (start/stop/restart)
- [ ] `src/lib/plugins/hermes/memory.js` (memory store)
- [ ] `src/lib/plugins/hermes/extraction.js` (extract facts)
- [ ] `src/lib/plugins/hermes/telegram.js` (telegram gateway)
- [ ] `src/lib/hermesService.js` (lifecycle entry, kalau belum ada di next)
- [ ] `src/sse/handlers/chat.js` inject Hermes memory context + persist user facts — **3-way merge dengan next** (next mungkin sudah punya memory injection berbeda)
- [ ] Auto-start di startup: `src/lib/initializeApp.js` (extend: + Hermes + Headroom)
- [ ] UI: `src/app/(dashboard)/dashboard/extended/page.js` + `ExtendedClient.js` + `components/HermesPluginCard.js` (new page `/dashboard/extended`)
- [ ] API routes 11 file di `src/app/api/plugins/hermes/`:
  - [ ] `dashboard/route.js`
  - [ ] `install/route.js`
  - [ ] `logs/route.js`
  - [ ] `restart/route.js`
  - [ ] `start/route.js`
  - [ ] `status/route.js`
  - [ ] `stop/route.js`
  - [ ] `telegram/route.js`
  - [ ] `update/route.js`
  - [ ] `update-check/route.js` (di `src/app/api/plugins/`, bukan di `plugins/hermes/`)
- [ ] `src/dashboardGuard.js` enforce local-only on spawn routes — **3-way merge dengan next** (next sudah enforce sendiri, cek `389ddbc4` + `8be44441`)
- [ ] `src/app/api/cli-tools/hermes-settings/route.js` (next sudah punya, **bandingkan isi**)
- [ ] `src/app/api/cli-tools/cowork-mcp-tools/route.js` (next sudah punya — bandingkan)
- [ ] `src/app/api/cli-tools/all-statuses/route.js` (bandingkan)

**Verify:** `npx vitest run unit/hermes-plugin.test.js unit/hermes-memory.test.js unit/hermes-extraction.test.js`

---

## FASE 4 — Skills hub & local skill router

- [ ] `src/lib/skillsRegistry.js` (registry loader)
- [ ] `src/skills/autoRouter.js` (TF-IDF classifier + request injection)
- [ ] `src/skills/localSkillRouter.js` (smart topic routing)
- [ ] `src/skills/tfidf.js` (generic scoring engine, refactored)
- [ ] `open-sse/rtk/genericPrompt.js` (new — bukan cuma Qoder-specific)
- [ ] `open-sse/rtk/trim.js` (sliding-window token trim)
- [ ] `src/lib/tokensaver/dedup-prompt.js` (prompt dedup)
- [ ] `src/lib/tokensaver/trim.js` (trim entry)
- [ ] `src/shared/components/ConfigSlider.js` (decimal + step support)
- [ ] Wire: `src/sse/handlers/chat.js` skill injection + continuity notice + dedup — **3-way merge dengan next** (next punya flow sendiri)
- [ ] Wire: `open-sse/handlers/chatCore.js` strip provider-level continuity (commit `8b658b2e`)
- [ ] UI: `ExtendedClient.js` cards untuk: Anti-Slop, Token Saver, ECC Auto Router, Custom Skill Studio — **3-way merge**, next mungkin sudah punya sebagian
- [ ] API: `src/app/api/skills/route.js` + `install/route.js` + `sync-ecc/route.js`
- [ ] `src/app/(dashboard)/dashboard/profile/page.js` password-in-headers fix (commit `eb936b78`) — bandingkan dengan next
- [ ] `scripts/sync-ecc-skills.js` (sync script)
- [ ] `scripts/check-local-only-coverage.mjs` (coverage check)
- [ ] Copy 594 file `skills/` dari extended → next (zero conflict, mass copy)

**Verify:** `npx vitest run unit/ecc-auto-router.test.js unit/local-skill-router.test.js unit/tfidf.test.js unit/tokensaver-trim.test.js`

---

## FASE 5 — Setup wizard, autostart, update check, infra

- [ ] `src/app/setup/page.js` (first-run setup wizard) + `SetupWizardModal.js`
- [ ] `src/app/(dashboard)/dashboard/extended/components/...` (new components kalau ada)
- [ ] `src/lib/autostart.js` (native OS autostart, no PM2)
- [ ] `src/lib/updateCheck.js` (update utility)
- [ ] `src/app/api/autostart/route.js`
- [ ] `src/app/api/tunnel/update/route.js`
- [ ] `src/app/api/pxpipe/update/route.js`
- [ ] `src/lib/tunnel/cloudflare/version.js`
- [ ] `src/app/api/version/update/route.js` (bandingkan dengan next)
- [ ] `src/app/api/version/route.js` (bandingkan dengan next)
- [ ] `src/app/landing/*` — **3-way merge** (next sudah custom landing, extended juga punya — diff besar)
- [ ] `src/lib/session/cache.js` (session LRU, `c44bae9f`)

**Verify:** `npx vitest run unit/update-check.test.js`

---

## FASE 6 — Test suite (porting tests from extended)

Semua dari `tests/unit/`:

- [ ] `api-routes.test.js`
- [ ] `diagnostics.test.js`
- [ ] `ecc-auto-router.test.js`
- [ ] `freebuff-strict-model-assignment.test.js`
- [ ] `health-and-session.test.js`
- [ ] `hermes-extraction.test.js`
- [ ] `hermes-memory.test.js`
- [ ] `hermes-plugin.test.js`
- [ ] `local-skill-router.test.js`
- [ ] `model-probe-suggest.test.js`
- [ ] `module-independence.test.js`
- [ ] `provider-test.test.js`
- [ ] `tfidf.test.js`
- [ ] `tokensaver-trim.test.js`
- [ ] `update-check.test.js`
- [ ] `mem-budget.test.js` (root tests/)
- [ ] `translator/__snapshots__/golden-url-header.test.js.snap` (snapshot)
- [ ] `tests/results.json` (baseline output)

**Verify:** `cd tests && npx vitest run` lalu `tests/__baseline__/verify-no-regression.mjs` — pastikan tidak ada regresi vs baseline.

---

## FASE 7 — opencode-go compatibility (REGRESI GUARD)

**SANGAT KRITIS** — opencode-go ada di `next` tapi TIDAK di `extended`. Saat merge FASE 2/3, JANGAN timpa file opencode-go.

- [ ] Konfirmasi `open-sse/executors/opencode-go.js` di-keep apa adanya
- [ ] Konfirmasi `open-sse/services/usage/opencode-go.js` di-keep
- [ ] Konfirmasi `open-sse/services/thoughtSignatureStore.js` di-keep
- [ ] Konfirmasi `open-sse/providers/registry/opencode-go.js` di-keep
- [ ] Test `opencode-go-*.test.js` (5 file di next-only) harus tetap PASS
- [ ] `tests/unit/opencode-go-muse-spark-responses.test.js`
- [ ] `tests/unit/opencode-go-session.test.js`
- [ ] `tests/unit/opencode-go-usage.test.js`
- [ ] `tests/unit/responses-parallel-tool-calls.test.js`
- [ ] `tests/unit/codex-image-models.test.js`

**Verify:** `cd tests && npx vitest run unit/opencode-go-*.test.js unit/codex-image-models.test.js unit/responses-parallel-tool-calls.test.js`

---

## FASE 8 — Build & verify

- [ ] `npm install` (regen `package-lock.json`)
- [ ] `npm run build` (webpack) — fix lint errors
- [ ] `npm run start` — manual smoke test
- [ ] `cd tests && npx vitest run` — full suite
- [ ] `tests/__baseline__/verify-no-regression.mjs` — no regression
- [ ] Open dashboard di browser, cek:
  - [ ] Sidebar shows `/dashboard/extended`
  - [ ] `/dashboard/providers` has RoutingHealthMonitor
  - [ ] `/dashboard/usage` shows non-zero `activeProviders`
  - [ ] `/dashboard/token-saver` shows trim controls
  - [ ] Skills hub loads
  - [ ] (kalau ada) Hermes card renders (tanpa install = empty state OK)
- [ ] CHANGELOG.md tulis ringkasan: rename + extended features merged
- [ ] Tag release: `v0.5.70-xrouter-extended` atau sesuai konvensi

---

## File yang JANGAN disentuh (kompatibilitas)

- `custom-server.js` — IP extraction + X-Forwarded-For handling (security invariant, CLAUDE.md)
- `src/lib/db/driver.js` — adapter chain (next masih pakai)
- Path `~/.9router/` — keep, atau tambah migration shim di `src/lib/db/migrate.js`
- `better-sqlite3` di `optionalDependencies` — keep (CLAUDE.md)
- `JWT_SECRET`, `INITIAL_PASSWORD`, `API_KEY_SECRET` env — keep

---

## Order eksekusi (paling aman → paling berisiko)

1. FASE 0 (rename, isolated)
2. FASE 1 (freebuff, source baru)
3. FASE 6 (test infra lebih dulu — gagal di sini = fix sebelum lanjut)
4. FASE 4 (skills, copy massal zero conflict)
5. FASE 5 (autostart + update check, infra)
6. FASE 2 (routing health — 3-way merge dengan next)
7. FASE 3 (Hermes — paling besar, 11 API + banyak file)
8. FASE 7 (regresi guard opencode-go)
9. FASE 8 (build & verify)
