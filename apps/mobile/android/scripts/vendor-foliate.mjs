// Vendor the foliate-js JS reader bundle into the Android app's
// `assets/foliate/` tree. Idempotent — re-runs cleanly when the
// pinned version bumps.
//
// Usage:
//   node scripts/vendor-foliate.mjs            # uses VERSION below
//   node scripts/vendor-foliate.mjs 1.2.3      # override version
//
// What it does:
//   1. Fetch the npm tarball for foliate-js@<version> from
//      registry.npmjs.org.
//   2. Verify BOTH SHA-1 (npm `dist.shasum`) and SHA-512 SRI
//      (npm `dist.integrity`) against the pinned values. SHA-1 is
//      preserved for parity with what npm publishes, but the SHA-512
//      is the load-bearing collision-resistant check (code review N1,
//      item #4).
//   3. Extract to a temp dir using the system `tar`.
//   4. Wipe and repopulate `app/src/main/assets/foliate/` with the
//      runtime subset (no tests, no rollup helpers, no example
//      reader.html, no README/package.json — those are build / npm
//      metadata, not APK payload).
//   5. Preserve LICENSE alongside as `LICENSE.txt` so the APK ships
//      attribution.
//   6. Preserve Spine-authored host files (`index.html`,
//      `spine-host.mjs`, `spine-host.css`) across re-runs by copying
//      them into the temp work dir BEFORE the destination wipe.
//      Earlier versions of this script read them, then `rm`'d the
//      directory, then wrote them back — a crash between rm and
//      writeFile would have lost the host page (code review N1 #6).
//
// Why this exists rather than a `pnpm install` hook: the mobile lane
// is intentionally self-contained. We don't want the Android build to
// require a populated `apps/desktop/node_modules/`. This script pulls
// the one package we need directly.
//
// Network policy on the dev VM: `registry.npmjs.org` is on the host
// router's dnsmasq allowlist. If this script ever fails at the fetch
// step on a fresh VM, that's the first thing to check.

import { mkdir, mkdtemp, copyFile, rm, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const VERSION = process.argv[2] ?? '1.0.1'
// Pinned digests from `npm view foliate-js@1.0.1 dist`. SHA-1 is the
// historical `dist.shasum`; SHA-512 is the SRI `dist.integrity`
// (base64-encoded). Update both when bumping the version.
const PINNED_DIGESTS = {
  '1.0.1': {
    sha1:   'bcd143845d2ee184c37aedccc271af0c6a0110b1',
    sha512: 'Cj4h2ub5aVA+yUgbhvVhCyxwi0GPF4pyNBa6Lw9+6WKY1ReBxipItn2kEBO6u7Vu/xYXjK711R74+t+yW/0u5w==',
  },
}

// Files we ship into the APK. Anything not on this list is dropped.
// All paths relative to the extracted `package/` root.
const RUNTIME_FILES = [
  // Core entry + EPUB stack
  'view.js',
  'epub.js',
  'epubcfi.js',
  'progress.js',
  'overlayer.js',
  'text-walker.js',
  // Renderers (dynamically imported by view.js)
  'paginator.js',
  'fixed-layout.js',
  // Optional features (may be dynamically imported)
  'footnotes.js',
  'search.js',
  'dict.js',
  'tts.js',
  'opds.js',
  'quote-image.js',
  'uri-template.js',
  // Other format readers — not used for EPUB but harmless and
  // small; foliate's view.js dynamically imports them only for
  // matching file types.
  'comic-book.js',
  'fb2.js',
  'mobi.js',
  // ZIP + fflate vendored shims
  'vendor/zip.js',
  'vendor/fflate.js',
  // UI helpers used by the renderer
  'ui/menu.js',
  'ui/tree.js',
]

// Spine-authored files that live alongside the vendored foliate
// bundle. Preserved across re-runs of this script. Anything in this
// list that already exists in ASSETS_DIR is staged into the temp
// work dir before the wipe and restored afterwards.
const PRESERVE_FILES = [
  'index.html',
  'spine-host.mjs',
  'spine-host.css',
]

const __dirname = dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = join(__dirname, '..', 'app', 'src', 'main', 'assets', 'foliate')

async function main() {
  const expected = PINNED_DIGESTS[VERSION]
  if (!expected) {
    throw new Error(
      `No pinned digests for foliate-js@${VERSION}. ` +
      `Update PINNED_DIGESTS in this script before bumping.`,
    )
  }

  const tarballUrl = `https://registry.npmjs.org/foliate-js/-/foliate-js-${VERSION}.tgz`
  console.log(`[vendor] fetching ${tarballUrl}`)
  const res = await fetch(tarballUrl)
  if (!res.ok) {
    throw new Error(`tarball fetch failed: ${res.status} ${res.statusText}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const actualSha1 = createHash('sha1').update(buf).digest('hex')
  const actualSha512 = createHash('sha512').update(buf).digest('base64')
  if (actualSha1 !== expected.sha1) {
    throw new Error(
      `sha1 mismatch: expected ${expected.sha1}, got ${actualSha1}. ` +
      `Tarball may have been replaced upstream — investigate before trusting.`,
    )
  }
  if (actualSha512 !== expected.sha512) {
    throw new Error(
      `sha512 mismatch: expected ${expected.sha512}, got ${actualSha512}. ` +
      `Tarball may have been replaced upstream — investigate before trusting.`,
    )
  }
  console.log(`[vendor] sha1 + sha512 verified`)

  const work = await mkdtemp(join(tmpdir(), 'foliate-vendor-'))
  try {
    const tarball = join(work, 'foliate-js.tgz')
    await writeFile(tarball, buf)
    console.log(`[vendor] extracting to ${work}`)
    await execFileP('tar', ['-xzf', tarball, '-C', work])

    const pkgRoot = join(work, 'package')

    // Stage Spine-authored host files into the temp work dir BEFORE
    // wiping the destination. If anything below explodes after the
    // rm, the temp copies are still on disk and a hand-rerun
    // recovers them. (Earlier version read them into memory and
    // wrote them back, which lost data on crash between rm and
    // writeFile — code review N1 #6.)
    const preserveStage = join(work, 'preserve')
    await mkdir(preserveStage, { recursive: true })
    const staged = []
    for (const rel of PRESERVE_FILES) {
      const src = join(ASSETS_DIR, rel)
      try {
        const bytes = await readFile(src)
        const dst = join(preserveStage, rel)
        await mkdir(dirname(dst), { recursive: true })
        await writeFile(dst, bytes)
        staged.push(rel)
      } catch (e) {
        if (e?.code !== 'ENOENT') throw e
        // First vendor run, or this file was added later. That's
        // fine — nothing to preserve.
      }
    }

    await rm(ASSETS_DIR, { recursive: true, force: true })
    await mkdir(ASSETS_DIR, { recursive: true })

    // Restore Spine-authored host files from the temp stage.
    for (const rel of staged) {
      const src = join(preserveStage, rel)
      const dst = join(ASSETS_DIR, rel)
      await mkdir(dirname(dst), { recursive: true })
      await copyFile(src, dst)
    }

    // Copy the runtime subset.
    for (const rel of RUNTIME_FILES) {
      const src = join(pkgRoot, rel)
      const dst = join(ASSETS_DIR, rel)
      await mkdir(dirname(dst), { recursive: true })
      await copyFile(src, dst)
    }

    // Re-apply Spine-side source patches against the freshly-copied
    // upstream files. Each patch is a deterministic string-replace
    // that throws if the expected source shape no longer matches —
    // upstream version bumps that move the patched lines fail loudly
    // here rather than silently dropping the patch.
    await applySpinePatches(ASSETS_DIR)

    // Ship the LICENSE alongside (required by foliate-js's MIT terms).
    await copyFile(join(pkgRoot, 'LICENSE'), join(ASSETS_DIR, 'LICENSE.txt'))

    // Drop a small stamp so it's obvious at a glance which version
    // is checked in.
    await writeFile(
      join(ASSETS_DIR, 'VERSION'),
      `foliate-js@${VERSION}\nsha1: ${actualSha1}\nsha512: ${actualSha512}\nvendored: ${new Date().toISOString()}\n`,
    )

    console.log(
      `[vendor] OK — ${RUNTIME_FILES.length} runtime files, ` +
      `${staged.length} Spine-authored files preserved, ` +
      `output in ${ASSETS_DIR}`,
    )
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/**
 * Verify Spine-side source patches are present in the vendored
 * foliate-js bundle. The patches themselves are non-trivial (they
 * introduce closure-captured locals around the change site) and
 * cannot be re-applied via a single string replace — see the patched
 * epub.js for the actual source. This step is verify-only:
 * idempotent re-runs are no-ops, and an upstream bump that drops
 * the patch surface fails loudly here so the next vendor sees the
 * regression rather than silently dropping it.
 */
async function applySpinePatches(assetsDir) {
  const patches = [
    {
      file: 'epub.js',
      reason: 'Lazy spine-item .size getter (code review N1-N6 critical #5)',
      sentinel: '_sizeCache ?? (_sizeCache = epubSelf.getSize(item.href))',
      hint: 'Search for SPINE-PATCH inside the .map() spine block in the prior checkout.',
    },
    {
      file: 'paginator.js',
      reason: 'Guard scrollBy/snap against undefined #scrollBounds (on-device 0.1.4 smoke)',
      sentinel: 'SPINE-PATCH: ignore touch-driven scrollBy',
      hint: 'Search for SPINE-PATCH in scrollBy and snap; both early-return when #scrollBounds is undefined.',
    },
    {
      file: 'paginator.js',
      reason: 'WebView iframe blob: → srcdoc fallback (on-device 0.1.10 smoke)',
      sentinel: 'WebView does not fire the iframe `load` event reliably',
      hint: 'View.load patched: detects blob: src, fetches HTML text, hands to iframe via srcdoc + 5s load-event timeout.',
    },
  ]
  for (const p of patches) {
    const path = join(assetsDir, p.file)
    const src = await readFile(path, 'utf8')
    if (src.includes(p.sentinel)) {
      console.log(`[vendor] patch present: ${p.file} (${p.reason})`)
      continue
    }
    throw new Error(
      `[vendor] patch missing from ${p.file} after re-vendor: ${p.reason}. ${p.hint}`,
    )
  }
}

main().catch(err => {
  console.error(`[vendor] FAIL: ${err.message}`)
  process.exit(1)
})
