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
| Sync terakhir (upstream) | **`8e15f0bd`** — rilis v0.5.79 (2026-09-18) |
| Upstream tip saat sync | `a8c9d380` — v0.5.81 (hanya bump versi, tidak ada substansi) |
| Sync sebelumnya (upstream) | `6d11ebc0` — v0.5.75 |
| HEAD fork saat sync | `3b945603` |
| Versi fork | `0.1.1` (jalur versi sendiri — bump upstream tidak diikuti) |
| Tanggal sync | 2026-09-20 |

### Next check

Mulai dari `a8c9d380` (upstream tip). v0.5.79 sudah di-port habis; v0.5.81 hanya
bump versi sehingga tidak ada yang perlu diambil. Sync berikutnya:

```bash
git log --oneline a8c9d380..upstream/master
```

### Catatan penting untuk sync berikutnya

**Jangan sentuh area ini tanpa membaca ledger `v0.5.79-2026-09-20.md` dulu.**
Fork sudah memodifikasi area-area berikut dengan pendekatan yang lebih baik
daripada upstream, dan upstream cenderung menimpanya:

- `open-sse/executors/opencode.js` — fingerprint tool stubs fork (bukan decoy tools upstream)
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
