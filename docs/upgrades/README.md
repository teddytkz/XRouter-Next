# Upstream Upgrade Ledger

Cara pakai: **sebelum mengerjakan fitur/perbaikan baru, baca file ini dulu.**
Bagian "Current state" memberi tahu sync terakhir ada di upstream commit mana.
Bagian "Next check" memberi tahu dari mana harus mulai memeriksa.

Satu file per sync di direktori ini, dinamai `vX.Y.Z-<tanggal>.md`.

## Cara sync berikutnya (ringkas)

```bash
# 1. Tarik upstream (repo upstream = /home/momo/9router/9router, bukan GitHub)
git fetch upstream

# 2. Lihat apa yang baru sejak sync terakhir (SHA ada di tabel Current state)
git log --oneline <LAST_SYNCED_SHA>..upstream/master

# 3. Coba cherry-pick satu per satu, catat mana yang konflik
for h in <sha...>; do git cherry-pick -x "$h" || { echo "CONFLICT $h"; git cherry-pick --abort; }; done

# 4. Cek regresi — JANGAN pakai `npx vitest run` mentah (lihat catatan di bawah)
cd tests && npx vitest run unit/ translator/ --reporter=json \
  --outputFile=/tmp/xr.json --exclude='**/.kilo/**'
cd .. && node tests/__baseline__/verify-no-regression.mjs /tmp/xr.json

# 5. Tulis file ledger baru + perbarui tabel di bawah
```

**Dua jebakan yang sudah pernah memakan waktu:**

1. `npx vitest run` tanpa `--exclude='**/.kilo/**'` akan ikut menyeret
   `.kilo/worktrees/*` — ratusan kegagalan palsu (`Cannot find package 'open-sse/index.js'`).
2. Gate `verify-no-regression.mjs` harus dijalankan dari **root repo**, bukan dari
   `tests/` (path relatifnya salah kalau dari `tests/`).

Suite memang tidak hijau di checkout bersih. Yang perlu dijaga: **tidak ada test
yang tadinya lulus jadi gagal.** Kegagalan pre-existing yang normal:

- `translator/golden-url-header.test.js` (cline/clinepass/kimi) — snapshot fork.
- `unit/cline-free-models-envelope.test.js` — model cline khas fork.
- `unit/embeddings.cloud.test.js` — `cloud/` tidak ada di repo ini.
- `unit/xai-oauth-service.test.js` — timeout tanpa mock.

## Current state

| Item | Nilai |
|---|---|
| Fork | XRouter-Next (`teddytkz/XRouter-Next`) |
| Upstream | `/home/momo/9router/9router` (`decolua/9router`), remote `upstream` |
| Sync terakhir (upstream) | **`f39d8f07`** — rilis v0.5.109 (2026-10-23) |
| Upstream tip saat sync | `f39d8f07` — v0.5.109 (sama, sudah di tip) |
| Sync sebelumnya (upstream) | `87a74e1b` — v0.5.104; `ce4460ef` — v0.5.99 |
| HEAD fork saat sync | `270c3205` (v0.1.10) |
| Versi fork | `0.1.10` (jalur versi sendiri — bump upstream tidak diikuti) |
| Tanggal sync | 2026-10-26 |

### Next check

Mulai dari `f39d8f07` (upstream tip). Sync berikutnya:

```bash
git fetch upstream
git log --oneline f39d8f07..upstream/master
```

Rentang v0.5.104→v0.5.109 berisi 38 commit, di-cherry-pick satu per satu
(36 masuk, 0 regresi). `38a0c449` (web-cookie) sengaja ditunda. Lihat
`v0.5.109-2026-10-26.md`.

### Catatan penting untuk sync berikutnya

**Jangan sentuh area ini tanpa membaca ledger `v0.5.79-2026-09-20.md` dulu.**
Fork sudah memodifikasi area-area berikut dengan pendekatan yang lebih baik
daripada upstream, dan upstream cenderung menimpanya:

- `open-sse/executors/opencode.js` — fingerprint tool stubs fork (bukan decoy tools upstream)
- `open-sse/utils/opencodeFingerprint.js` — fork mengisi schema tool reserved, tidak me-rename tool caller (upstream `concealFingerprintToolNames`)
- `open-sse/utils/proxyFetch.js` — got-scraping dimatikan di fork; jangan reintroduksi routing per-host tanpa tes
- `open-sse/utils/sessionManager.js` — session reuse generik fork (bukan per-executor map upstream)
- `open-sse/providers/registry/{cline,clinepass,freebuff}.js` — provider khas fork
- `open-sse/executors/freebuff.js`, `open-sse/services/usage/freebuff.js`
- `src/app/(dashboard)/dashboard/providers/[id]/page.js` — banyak fitur dashboard fork

Lihat juga `CLAUDE.md` di root untuk aturan repo dan `docs/ARCHITECTURE.md` untuk
gambaran sistem.

## Ledger

| Sync | Upstream | Tanggal | File | Hasil |
|---|---|---|---|---|
| v0.5.69 → v0.5.75 | `6d11ebc0` | 2026-09-10 | — (belum ada ledger) | 11 file konflik, digabung manual |
| v0.5.76 → v0.5.79 | `8e15f0bd` | 2026-09-20 | [v0.5.79-2026-09-20.md](./v0.5.79-2026-09-20.md) | 21 commit: 17 cherry-pick + 4 manual |
| v0.5.79 → v0.5.99 | `ce4460ef` | 2026-10-10 | [v0.5.99-2026-10-10.md](./v0.5.99-2026-10-10.md) | 151 commit via merge: 48 file konflik, 0 regresi |
| Port VansRouter | — (fork saudara) | 2026-10-11 | [v0.1.5-2026-10-11.md](./v0.1.5-2026-10-11.md) | 29 provider + token saver + security/ops hardening, 0 regresi |
| v0.5.104 → v0.5.109 | `f39d8f07` | 2026-10-26 | [v0.5.109-2026-10-26.md](./v0.5.109-2026-10-26.md) | 36 cherry-pick (web-cookie ditunda), 4 konflik manual, 0 regresi |
| Port VansRouter (gap) | — (fork saudara) | 2026-10-26 | [v0.1.10-2026-10-26-vans-gap.md](./v0.1.10-2026-10-26-vans-gap.md) | CodeBuddy sanitasi, loop guard, apiKeyName, kuota Kimchi, free tier, context_length combo, 0 regresi |
