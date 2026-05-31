package com.thereprocase.spine

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.net.URLDecoder
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import javax.xml.XMLConstants
import javax.xml.parsers.DocumentBuilder
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Cover heuristic, ported from the demo's
 * `apps/mobile-reader/src/ui/Cover.tsx`:
 *
 *   1. Look for an embedded cover image inside the EPUB. Resolved
 *      via the manifest's `properties="cover-image"` attribute, then
 *      `<meta name="cover">` → manifest item id, then a path
 *      heuristic (`cover.{jpg,jpeg,png}` near the OPF).
 *   2. If no image survives that, render a "paperboard" generated
 *      cover — a flat rectangle in the theme accent with the book
 *      title centered. Looks deliberately bookish, not stand-in-art.
 *
 * The extracted bitmap is cached under
 * `${booksDir}/.covers/${id}.bin` so repeated home-screen / library
 * renders don't re-read the EPUB. Cache files are deleted alongside
 * their book record by [LibraryStore.removeBook] (which deletes the
 * whole entry filename — for cover cache invalidation we do a
 * lazy "if cached file is newer than the EPUB, use it" check).
 */
object Cover {

    private fun coversDir(ctx: Context): File =
        File(LibraryStore.booksDir(ctx), ".covers").apply { if (!exists()) mkdirs() }

    /**
     * Load (or extract + cache) the cover bitmap for [book]. Returns
     * null if the EPUB has no usable cover image — the caller should
     * fall back to the generated paperboard cover.
     *
     * Decoded with `inSampleSize` so very large covers don't allocate
     * a 100 MB Bitmap; target ~512 px on the longer edge, which is
     * larger than the home-screen Resume card (~256 px) but small
     * enough that the bytes don't matter.
     */
    suspend fun load(ctx: Context, book: LibraryStore.BookEntry): Bitmap? =
        withContext(Dispatchers.IO) {
            val cache = File(coversDir(ctx), "${book.id}.bin")
            val source = File(LibraryStore.booksDir(ctx), book.filename)
            if (!source.isFile) return@withContext null
            if (cache.isFile && cache.lastModified() >= source.lastModified()) {
                return@withContext decodeFile(cache)
            }
            // Stream cover bytes directly to the cache file with a
            // bounded buffer; never load the full entry into JVM heap.
            // A legitimate 30 MB embedded cover (archival EPUB,
            // commissioned-art fanfic) used to allocate ~2× its size
            // in heap before the bitmap-bounds check could trip.
            // (code review N1-N6 critical #6.)
            if (!streamCoverToFile(source, cache)) return@withContext null
            decodeFile(cache)
        }

    /** Per-cover-entry byte cap. Mirrors [SpineZip.MAX_ENTRY_BYTES]
     *  scaled down — a single cover image over 200 MB is implausible
     *  and almost certainly adversarial. */
    private const val MAX_COVER_BYTES: Long = 200L * 1024 * 1024

    /**
     * Hard cap on the source pixel count we'll let through the
     * second decode. 4096 × 4096 = ~16 Mpx, which subsamples down to
     * ~512 px without any practical visual loss for a cover. Larger
     * declared dimensions are rejected outright — the bounds-only
     * pass still reads the (attacker-controlled) header bytes, but
     * we refuse to allocate against them. code review N3 #3.
     */
    private const val MAX_DECLARED_PIXELS = 4096L * 4096L

    private fun decodeFile(file: File): Bitmap? {
        // Two-pass decode: bounds-only first to compute inSampleSize
        // and reject oversize headers, then full decode. Wrapped in
        // try/catch because BitmapFactory can throw on malformed
        // input (not just return null).
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.absolutePath, bounds)
            val w = bounds.outWidth
            val h = bounds.outHeight
            if (w <= 0 || h <= 0) return null
            if (w.toLong() * h.toLong() > MAX_DECLARED_PIXELS) {
                android.util.Log.w(
                    "Cover",
                    "Refusing oversized cover: ${w}x${h} from ${file.name}",
                )
                return null
            }
            var sample = 1
            val target = 512
            val longest = maxOf(w, h)
            while (longest / sample > target) sample *= 2
            val opts = BitmapFactory.Options().apply { inSampleSize = sample }
            BitmapFactory.decodeFile(file.absolutePath, opts)
        } catch (e: Exception) {
            android.util.Log.w("Cover", "Decode failed for ${file.name}: ${e.message}")
            null
        } catch (e: OutOfMemoryError) {
            android.util.Log.w("Cover", "OOM decoding ${file.name}")
            null
        }
    }

    /** Stream cover image bytes from the EPUB directly to [cacheOut].
     *  Walks the OPF manifest the same way the prior in-memory variant
     *  did, but uses a bounded buffer so peak heap stays at ~8 KB
     *  regardless of source size. Returns true on success, false on
     *  any failure. Errors are logged at warn level rather than
     *  swallowed silently (code review N3 #2). */
    private fun streamCoverToFile(epub: File, cacheOut: File): Boolean {
        return try {
            ZipFile(epub).use { zip ->
                val opfPath = findOpfPath(zip) ?: return@use false
                val opfEntry = zip.getEntry(opfPath) ?: return@use false
                // OPF documents are small (manifest + spine + metadata),
                // so reading them as bytes for the XML parser is fine.
                val opfBytes = zip.getInputStream(opfEntry).use { it.readBytes() }
                val coverHref = findCoverHrefInOpf(opfBytes) ?: return@use false
                // OPF hrefs are IRI-encoded — `My%20Cover.jpg` is a
                // legitimate value. URL-decode before zip lookup
                // (code review N3 #1).
                val decoded = try {
                    URLDecoder.decode(coverHref, Charsets.UTF_8.name())
                } catch (_: Exception) {
                    coverHref
                }
                val opfBase = opfPath.substringBeforeLast('/', "")
                val resolved = if (opfBase.isEmpty()) decoded else "$opfBase/$decoded"
                val normalised = resolved.replace("/./", "/").trimStart('/')
                // ZipFile.getEntry does byte-exact matching, so a
                // path-traversal lookup (`../foo`) only matches if
                // the central directory literally contains that
                // entry name. Java's ZipFile does NOT canonicalise
                // entry names, so a hostile zip carrying such an
                // entry would be returned verbatim — but the only
                // consequence is "the bytes are decoded as a
                // bitmap," which the bounds + pixel cap in
                // decodeFile already defends. (code review N3 #2.)
                val coverEntry: ZipEntry =
                    zip.getEntry(normalised) ?: zip.getEntry(decoded) ?: return@use false
                val buf = ByteArray(DEFAULT_BUFFER_SIZE)
                var written = 0L
                cacheOut.parentFile?.mkdirs()
                zip.getInputStream(coverEntry).use { input ->
                    FileOutputStream(cacheOut).use { output ->
                        while (true) {
                            val n = input.read(buf)
                            if (n <= 0) break
                            if (written + n > MAX_COVER_BYTES) {
                                output.close()
                                cacheOut.delete()
                                android.util.Log.w(
                                    "Cover",
                                    "Refused oversized cover from ${epub.name} " +
                                        "(${MAX_COVER_BYTES / (1024 * 1024)} MB cap)",
                                )
                                return@use false
                            }
                            output.write(buf, 0, n)
                            written += n
                        }
                    }
                }
                true
            }
        } catch (e: Exception) {
            android.util.Log.w(
                "Cover",
                "streamCoverToFile failed for ${epub.name}: ${e.javaClass.simpleName}: ${e.message}",
            )
            cacheOut.delete()
            false
        }
    }

    /**
     * XML parser hardened against XXE: DOCTYPE declarations are
     * disallowed entirely, external entities are disabled, and the
     * `FEATURE_SECURE_PROCESSING` flag asks the implementation for
     * its safest mode. Without these, a hostile EPUB's
     * `container.xml` or OPF could trigger billion-laughs entity
     * expansion or read app-private files (code review N3 #1).
     */
    private fun safeDocumentBuilder(): DocumentBuilder {
        val factory = DocumentBuilderFactory.newInstance().apply {
            isNamespaceAware = false
            try { setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true) } catch (_: Exception) {}
            try { setFeature("http://apache.org/xml/features/disallow-doctype-decl", true) } catch (_: Exception) {}
            try { setFeature("http://xml.org/sax/features/external-general-entities", false) } catch (_: Exception) {}
            try { setFeature("http://xml.org/sax/features/external-parameter-entities", false) } catch (_: Exception) {}
            try { setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false) } catch (_: Exception) {}
            isXIncludeAware = false
            isExpandEntityReferences = false
        }
        return factory.newDocumentBuilder()
    }

    private fun findOpfPath(zip: ZipFile): String? {
        val container = zip.getEntry("META-INF/container.xml") ?: return null
        val xml = zip.getInputStream(container).use { it.readBytes() }
        val doc = safeDocumentBuilder().parse(xml.inputStream())
        val rootfiles = doc.getElementsByTagName("rootfile")
        for (i in 0 until rootfiles.length) {
            val node = rootfiles.item(i)
            val attrs = node.attributes ?: continue
            val full = attrs.getNamedItem("full-path")?.nodeValue
            if (!full.isNullOrBlank()) return full
        }
        return null
    }

    private fun findCoverHrefInOpf(opfBytes: ByteArray): String? {
        val doc = safeDocumentBuilder().parse(opfBytes.inputStream())
        val items = doc.getElementsByTagName("item")
        // Pass 1: properties="cover-image" (EPUB 3 idiom).
        for (i in 0 until items.length) {
            val attrs = items.item(i).attributes ?: continue
            val props = attrs.getNamedItem("properties")?.nodeValue ?: continue
            if (props.split(' ').contains("cover-image")) {
                val href = attrs.getNamedItem("href")?.nodeValue
                if (!href.isNullOrBlank()) return href
            }
        }
        // Pass 2: <meta name="cover" content="<id>"> → manifest item.
        val metas = doc.getElementsByTagName("meta")
        var coverIdRef: String? = null
        for (i in 0 until metas.length) {
            val attrs = metas.item(i).attributes ?: continue
            if (attrs.getNamedItem("name")?.nodeValue == "cover") {
                coverIdRef = attrs.getNamedItem("content")?.nodeValue
                break
            }
        }
        if (!coverIdRef.isNullOrBlank()) {
            for (i in 0 until items.length) {
                val attrs = items.item(i).attributes ?: continue
                if (attrs.getNamedItem("id")?.nodeValue == coverIdRef) {
                    val href = attrs.getNamedItem("href")?.nodeValue
                    if (!href.isNullOrBlank()) return href
                }
            }
        }
        // Pass 3: a manifest item with id literally "cover" or
        // "cover-image".
        for (i in 0 until items.length) {
            val attrs = items.item(i).attributes ?: continue
            val id = attrs.getNamedItem("id")?.nodeValue ?: continue
            if (id == "cover" || id == "cover-image") {
                val href = attrs.getNamedItem("href")?.nodeValue
                if (!href.isNullOrBlank()) return href
            }
        }
        return null
    }

    /** Render the embedded cover if it exists, otherwise a generated
     *  paperboard cover with the book title. The composable is
     *  side-effecting (loads the bitmap on a background dispatcher
     *  the first time it's seen) so it can be dropped into a
     *  LazyVerticalGrid item without ceremony. */
    @Composable
    fun BookCover(
        book: LibraryStore.BookEntry,
        modifier: Modifier = Modifier,
    ) {
        val ctx = androidx.compose.ui.platform.LocalContext.current
        var bitmap by remember(book.id) { mutableStateOf<Bitmap?>(null) }
        var attempted by remember(book.id) { mutableStateOf(false) }
        LaunchedEffect(book.id) {
            bitmap = load(ctx, book)
            attempted = true
        }
        val palette = LocalSpinePalette.current
        Box(
            modifier = modifier
                .background(palette.surface),
            contentAlignment = Alignment.Center,
        ) {
            val bm = bitmap
            if (bm != null) {
                Image(
                    painter = BitmapPainter(bm.asImageBitmap()),
                    contentDescription = book.title,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            } else if (attempted) {
                // Paperboard fallback: title in centre, accent stripe
                // at the foot, theme surface as the body.
                Box(modifier = Modifier.fillMaxSize().padding(12.dp)) {
                    Text(
                        text = book.title,
                        color = palette.text,
                        textAlign = TextAlign.Center,
                        fontFamily = FontFamily.Serif,
                        maxLines = 6,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.align(Alignment.Center),
                    )
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(top = 0.dp, bottom = 0.dp),
                    )
                }
            }
        }
    }
}
