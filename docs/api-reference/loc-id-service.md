# API Reference: Library of Congress (id.loc.gov)

**Status:** Cached for Spine Phase 1 Development
**Date:** 2026-04-21

## 1. Core Endpoints

| API | Base URL | Purpose |
|---|---|---|
| **Search** | `https://id.loc.gov/search/` | Keyword search across LC resources. |
| **Suggest** | `https://id.loc.gov/authorities/names/suggest/` | Typeahead/Lookup for authors/names. |
| **Direct URI** | `https://id.loc.gov/resources/[works|instances]/[id]` | Retrieve a full BIBFRAME graph. |

## 2. Searching for BIBFRAME Works

To find a book like *Frankenstein* and get its BIBFRAME Work URI:

**Request:**
`GET https://id.loc.gov/search/?q=Frankenstein+Shelley&format=json`

**Parameters:**
*   `q`: The search query.
*   `format`: `json` (essential for our Rust/JS pipeline).
*   `memberOf`: (Optional) Filter by `http://id.loc.gov/resources/works` to limit to Works.

## 3. Retrieving a Specific Graph

Once a URI is found (e.g., `http://id.loc.gov/resources/works/c016028517`), fetch the content:

**Request:**
`GET http://id.loc.gov/resources/works/c016028517.jsonld`

**Supported Extensions:**
*   `.jsonld` (Recommended)
*   `.nt` (N-Triples)
*   `.rdf` (RDF/XML)

## 4. Name Authorities (Reconciling Authors)

To link "Mary Shelley" to her canonical URI:

**Request:**
`GET https://id.loc.gov/authorities/names/suggest/?q=Mary+Shelley`

**Response Shape:**
```json
[
  "Mary Shelley",
  ["Shelley, Mary Wollstonecraft, 1797-1851"],
  ["1 result"],
  ["http://id.loc.gov/authorities/names/n79061063"]
]
```

---

## 5. Notes for Spine Implementation
- **Rate Limiting:** LC doesn't strictly publish limits, but we should use a custom User-Agent and implement exponential backoff.
- **Dante Translation Discovery:** We need to search for "Divine Comedy" or "Inferno", identify the **Work**, and then look for associated **Instances** where `bf:provisionActivity` or `bf:contribution` mentions a translator.

---

## 6. Sample BIBFRAME Work structure

Based on a cached pull of `https://id.loc.gov/resources/works/11940412.jsonld` (Mary Shelley's *Frankenstein*, 2026-04-21).

### 6.1 Work identity
The root `@id` is `http://id.loc.gov/resources/works/11940412`, with multiple `@type` assertions:
- `bf:Work`
- `bf:MovingImage` *(LC often catalogs film adaptations as separate Works)*
- `bf:Monograph`

### 6.2 Administrative metadata (`bf:AdminMetadata`)
Blank nodes (`_:b…`) carry administrative tracking:
- `bf:status` — current state (`new`, `changed`, …)
- `bf:date` — creation/modification timestamps
- `bf:agent` — cataloging agency (e.g., `http://id.loc.gov/vocabulary/organizations/dlc`)

### 6.3 Titles (`bf:Title`)
Titles are nested objects, not raw strings:
```json
{
  "@type": ["bf:Title"],
  "bf:mainTitle": [{ "@value": "Frankenstein" }]
}
```

### 6.4 Instances (`bf:hasInstance`)
The Work links to its material embodiments, e.g. `http://id.loc.gov/resources/instances/11940412`.

### 6.5 Subject authorities (`bf:genreForm`)
Links to external LC authorities, e.g. `http://id.loc.gov/authorities/genreForms/gf2011026723` (video recordings).

### 6.6 Implementation notes for Spine ingest
- **Blank-node flattening** — resolve `_:b` identifiers into local `spine.db` during ingest (see `spine-bf::graph_scope_token` for the current graph-scoped labeling scheme).
- **Property mapping** — `bf:mainTitle` → `Book.title` fallback when missing.
- **Role extraction** — look at `bf:contribution` and `bf:role` to distinguish translators (`trl`) from authors (`aut`).
