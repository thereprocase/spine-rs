pub mod jsonld;
pub mod epub;
pub mod reconcile;
pub mod sweep;

pub use sweep::{
    backfill_pre_adr_reconcile_markers, background_reconcile_sweep, BackfillReport, SweepReport,
};

use reqwest::{Client, Url};
use serde::Deserialize;
use thiserror::Error;

// Cap on LoC SRU / JSON-LD response bodies. The LoC SRU endpoint returns
// paginated MARCXML; a single page should never approach 16 MB. If it does,
// something is wrong upstream or we are being fed a malicious response.
const LOC_MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

/// Default base URL for LCSH `suggest2` lookups. Authoritative LoC subject
/// headings are served from id.loc.gov over HTTPS (unlike the SRU endpoint,
/// which is plain-HTTP). See `search_lcsh_subject`.
const LCSH_DEFAULT_BASE_URL: &str = "https://id.loc.gov/authorities/subjects/suggest2";

#[derive(Error, Debug)]
pub enum Error {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("XML parsing error: {0}")]
    Xml(#[from] quick_xml::DeError),
    #[error("Invalid query: {0}")]
    Query(String),
    #[error("Response body too large: {0} bytes (limit {LOC_MAX_RESPONSE_BYTES})")]
    ResponseTooLarge(usize),
    #[error("UTF-8 decode error: {0}")]
    Utf8(#[from] std::str::Utf8Error),
    #[error("Client build error: {0}")]
    ClientBuild(reqwest::Error),
    #[error("URL parse error: {0}")]
    UrlParse(String),
    /// LCCN value from an untrusted MARCXML 001 field failed the allow-list check.
    /// Interpolating an unvalidated LCCN directly into the id.loc.gov URL would
    /// allow path traversal or injection of arbitrary path segments.
    #[error("Invalid LCCN format: {0}")]
    InvalidLccn(String),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone)]
pub struct LocClient {
    client: Client,
    base_url: Url,
    /// Base URL for LCSH `suggest2` queries. Defaults to
    /// `https://id.loc.gov/authorities/subjects/suggest2`. Override via
    /// `with_base_urls` for tests; production uses the default.
    lcsh_base_url: Url,
}

impl LocClient {
    /// Constructs a `LocClient` pointed at the LoC SRU endpoint.
    ///
    /// The SRU endpoint at `lx2.loc.gov:210` is only available over plain HTTP.
    /// There is no HTTPS-capable SRU mirror published by the Library of Congress
    /// as of the time this was written. The BIBFRAME JSON-LD lookups via
    /// `id.loc.gov` do use HTTPS. We log a warning at construction time so
    /// operators are aware of the cleartext leg.
    ///
    /// DEBT(security): monitor https://www.loc.gov/apis/ for an HTTPS SRU
    /// endpoint. If one becomes available, switch `base_url` here and remove the
    /// warning. Leaving this open means title/author queries travel in plaintext
    /// over networks the user does not control.
    pub fn new() -> Result<Self> {
        tracing::warn!(
            "LocClient SRU base URL uses plain HTTP (lx2.loc.gov:210). \
             No HTTPS SRU mirror is available from the Library of Congress. \
             Title and author query strings will be sent in cleartext."
        );
        let client = Client::builder()
            .user_agent("Spine/0.1.0 (https://github.com/thereprocase/spine)")
            .build()
            .map_err(Error::ClientBuild)?;
        let base_url = Url::parse("http://lx2.loc.gov:210/lcdb")
            .map_err(|e| Error::UrlParse(e.to_string()))?;
        let lcsh_base_url = Url::parse(LCSH_DEFAULT_BASE_URL)
            .map_err(|e| Error::UrlParse(e.to_string()))?;
        Ok(Self {
            client,
            base_url,
            lcsh_base_url,
        })
    }

    pub fn with_base_url(url: &str) -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .user_agent("Spine/0.1.0-test")
                .build()
                .map_err(Error::ClientBuild)?,
            base_url: Url::parse(url).map_err(|_| Error::Query(format!("Invalid URL: {}", url)))?,
            lcsh_base_url: Url::parse(LCSH_DEFAULT_BASE_URL)
                .map_err(|e| Error::UrlParse(e.to_string()))?,
        })
    }

    /// Test helper: override both the SRU and the LCSH base URLs. Useful
    /// when a single test wants to mockito-stub both legs.
    pub fn with_base_urls(sru_url: &str, lcsh_url: &str) -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .user_agent("Spine/0.1.0-test")
                .build()
                .map_err(Error::ClientBuild)?,
            base_url: Url::parse(sru_url)
                .map_err(|_| Error::Query(format!("Invalid SRU URL: {}", sru_url)))?,
            lcsh_base_url: Url::parse(lcsh_url)
                .map_err(|_| Error::Query(format!("Invalid LCSH URL: {}", lcsh_url)))?,
        })
    }

    pub async fn search_by_isbn(&self, isbn: &str) -> Result<String> {
        self.search(&format!("bath.isbn={}", isbn)).await
    }

    pub async fn search_by_title_author(&self, title: &str, author: &str) -> Result<String> {
        // Both values come from the local calibre library and ultimately from
        // the user or ingest pipeline, so they must be escaped before
        // interpolation into the CQL query string.
        let safe_title = cql_escape(title);
        let safe_author = cql_escape(author);
        self.search(&format!(
            "dc.title=\"{}\" AND dc.creator=\"{}\"",
            safe_title, safe_author
        ))
        .await
    }

    pub async fn search(&self, query: &str) -> Result<String> {
        // Log only the byte length, not the query content. Query strings are
        // derived from user-supplied book titles and author names; logging them
        // at INFO embeds personal library metadata in structured log streams
        // that may be shipped to third-party log aggregators.
        tracing::debug!("Querying LoC SRU ({}-byte query)", query.len());
        let res = self
            .client
            .get(self.base_url.clone())
            .query(&[
                ("operation", "searchRetrieve"),
                ("version", "1.1"),
                ("recordSchema", "marcxml"),
                ("query", query),
                ("maximumRecords", "10"),
            ])
            .send()
            .await?;

        res.error_for_status_ref()?;

        let bytes = res.bytes().await?;
        if bytes.len() > LOC_MAX_RESPONSE_BYTES {
            return Err(Error::ResponseTooLarge(bytes.len()));
        }
        let text = std::str::from_utf8(&bytes)?;
        Ok(text.to_owned())
    }

    pub async fn fetch_bibframe_json(&self, id: &str) -> Result<serde_json::Value> {
        let id = id.trim();
        // Validate the LCCN against a strict allow-list before interpolating it
        // into the id.loc.gov URL. LCCN values arrive from untrusted MARCXML 001
        // fields; without this check a crafted value like `../foo` could inject
        // arbitrary path segments or query parameters into the request URL.
        //
        // Format per LC LCCN normalisation rules: optional 2–3 lowercase alpha
        // prefix followed by 8–10 decimal digits. Examples: `n2001000002`,
        // `97001234`, `2019012345`. Reject anything else before it touches a URL.
        if !is_valid_lccn(id) {
            return Err(Error::InvalidLccn(id.to_string()));
        }
        let url = format!("https://id.loc.gov/resources/instances/{}.json", id);
        tracing::debug!("Fetching BIBFRAME JSON-LD for validated LCCN");
        let res = self.client.get(&url).send().await?;
        res.error_for_status_ref()?;
        let bytes = res.bytes().await?;
        if bytes.len() > LOC_MAX_RESPONSE_BYTES {
            return Err(Error::ResponseTooLarge(bytes.len()));
        }
        let json: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|e| Error::Query(format!("JSON decode error: {}", e)))?;
        Ok(json)
    }

    /// Query id.loc.gov LCSH `suggest2` for subject candidates matching a
    /// user-supplied prefix.
    ///
    /// Returns the hits in the order id.loc.gov returned them
    /// (`sortmethod=alpha`, `searchtype=left-anchored`). Per the LoC
    /// documentation and live verification, the first hit is the best match
    /// for the prefix; there is no numeric ranking surfaced. Each hit
    /// projects to `{ uri, label }` where `label` is the authoritative
    /// `aLabel` field (e.g. canonical `Dragons` rather than the
    /// display-oriented `suggestLabel` which sometimes carries inline scope
    /// notes).
    ///
    /// An empty (or whitespace-only) term short-circuits to `Ok(vec![])`
    /// without a network round-trip — id.loc.gov returns a 400 on `q=` and
    /// we don't want noise in the logs from autocomplete endpoints firing
    /// on a stripped input.
    ///
    /// `404 Not Found` from id.loc.gov is normalised to `Ok(vec![])`. The
    /// suggest2 endpoint occasionally returns 404 in cold-cache or
    /// deployment-rotation states, and `BlockingLocReconciler` treats a
    /// miss the same way it treats no hits (caller mints `urn:spine:*`
    /// flagged for background re-reconcile).
    pub async fn search_lcsh_subject(&self, term: &str) -> Result<Vec<LcshMatch>> {
        let trimmed = term.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        // Log only the byte length, not the term text. Subject queries are
        // user-supplied and embedding them at INFO would leak personal
        // library metadata into structured log streams.
        tracing::debug!("Querying LCSH suggest2 ({}-byte term)", trimmed.len());
        let res = self
            .client
            .get(self.lcsh_base_url.clone())
            .query(&[("q", trimmed)])
            .send()
            .await?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            tracing::debug!("LCSH suggest2 returned 404; treating as empty result");
            return Ok(Vec::new());
        }
        res.error_for_status_ref()?;
        let bytes = res.bytes().await?;
        if bytes.len() > LOC_MAX_RESPONSE_BYTES {
            return Err(Error::ResponseTooLarge(bytes.len()));
        }
        let parsed: Suggest2Response = serde_json::from_slice(&bytes)
            .map_err(|e| Error::Query(format!("LCSH JSON decode error: {}", e)))?;
        Ok(parsed
            .hits
            .into_iter()
            .map(|h| LcshMatch {
                uri: h.uri,
                label: h.a_label,
            })
            .collect())
    }
}

/// One LCSH `suggest2` hit projected down to the two fields Spine cares
/// about: the LoC authority URI and the authoritative `aLabel`.
///
/// Used by `LocClient::search_lcsh_subject` and
/// `BlockingLocReconciler::SubjectReconciler`. The `Serialize` /
/// `Deserialize` impls make this a stable wire shape for callers that
/// surface the list directly (e.g. the `/api/v1/loc/lcsh/suggest`
/// autocomplete endpoint).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LcshMatch {
    pub uri: String,
    pub label: String,
}

/// Internal: deserialization shape for the `id.loc.gov` LCSH `suggest2`
/// JSON response. Keeping this private keeps the public surface to
/// `LcshMatch`; we don't expose the upstream's full hit envelope (which
/// includes `suggestLabel`, `vLabel`, `code`, `token`, `more.*`, …) so a
/// future LoC change to non-essential fields doesn't leak into Spine's
/// public types.
#[derive(Deserialize)]
struct Suggest2Response {
    /// Per id.loc.gov: ordered alpha + left-anchored. We preserve order.
    #[serde(default)]
    hits: Vec<Suggest2Hit>,
}

#[derive(Deserialize)]
struct Suggest2Hit {
    /// Authoritative label — canonical preferred form, e.g. `"Dragons"`.
    #[serde(rename = "aLabel")]
    a_label: String,
    /// LoC subject authority URI, e.g.
    /// `http://id.loc.gov/authorities/subjects/sh85039287`.
    uri: String,
}

/// Validates an LCCN against the Library of Congress normalised format.
///
/// Accepted pattern: an optional alphabetic prefix of 1–3 lowercase ASCII letters
/// followed by 8–10 ASCII decimal digits, with no other characters. This covers
/// the two standard LC normalised forms:
///   - Pre-2001: 2-alpha prefix + 6 digits (normalised to 8) e.g. `n 97001234` → `n97001234`
///   - 2001+: no prefix + 10 digits e.g. `2001001234`
///
/// The validation is intentionally strict: anything containing `/`, `.`, spaces,
/// or non-ASCII is rejected before it can be interpolated into a URL path segment.
fn is_valid_lccn(id: &str) -> bool {
    if id.is_empty() {
        return false;
    }
    let bytes = id.as_bytes();
    // Count leading lowercase alpha characters (0–3).
    let alpha_len = bytes
        .iter()
        .take(3)
        .take_while(|&&b| b.is_ascii_lowercase())
        .count();
    let digit_part = &bytes[alpha_len..];
    // Digit segment must be 8–10 characters long and all decimal digits.
    let digit_len = digit_part.len();
    if !(8..=10).contains(&digit_len) {
        return false;
    }
    digit_part.iter().all(|b| b.is_ascii_digit())
}

/// Escapes a string for safe inclusion inside a CQL quoted-string literal.
///
/// CQL (Contextual Query Language, used by SRU) uses `"` to delimit string
/// values. An unescaped `"` or `\` in an attacker-controlled value would allow
/// injection of arbitrary query terms (e.g. `foo" OR cql.anywhere="bar`).
///
/// Rules applied:
/// - `\` → `\\`  (must come first to avoid double-escaping)
/// - `"` → `\"`
/// - ASCII control characters (< 0x20) stripped — they are not meaningful in
///   CQL and some SRU implementations parse them as terminators.
/// - `(` and `)` stripped — CQL grouping operators; would allow boolean
///   sub-expression injection even inside a quoted string on some servers.
/// - Result is capped at 200 characters to avoid query amplification.
fn cql_escape(input: &str) -> String {
    let escaped: String = input
        .chars()
        .filter(|&c| c >= '\x20' && c != '(' && c != ')')
        .flat_map(|c| {
            if c == '\\' {
                vec!['\\', '\\']
            } else if c == '"' {
                vec!['\\', '"']
            } else {
                vec![c]
            }
        })
        .take(200)
        .collect();
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_search_success() {
        let mut server = mockito::Server::new_async().await;

        let mock = server.mock("GET", "/")
            .match_query(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("operation".into(), "searchRetrieve".into()),
                mockito::Matcher::UrlEncoded("version".into(), "1.1".into()),
                mockito::Matcher::UrlEncoded("recordSchema".into(), "marcxml".into()),
                mockito::Matcher::UrlEncoded("query".into(), "test query".into()),
                mockito::Matcher::UrlEncoded("maximumRecords".into(), "10".into()),
            ]))
            .with_status(200)
            .with_body("<xml>Success</xml>")
            .create_async()
            .await;

        let client = LocClient::with_base_url(&server.url()).unwrap();
        let result = client.search("test query").await.unwrap();

        mock.assert_async().await;
        assert_eq!(result, "<xml>Success</xml>");
    }

    #[tokio::test]
    async fn test_search_error() {
        let mut server = mockito::Server::new_async().await;

        let mock = server.mock("GET", "/")
            .match_query(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("operation".into(), "searchRetrieve".into()),
                mockito::Matcher::UrlEncoded("version".into(), "1.1".into()),
                mockito::Matcher::UrlEncoded("recordSchema".into(), "marcxml".into()),
                mockito::Matcher::UrlEncoded("query".into(), "test query".into()),
                mockito::Matcher::UrlEncoded("maximumRecords".into(), "10".into()),
            ]))
            .with_status(500)
            .create_async()
            .await;

        let client = LocClient::with_base_url(&server.url()).unwrap();
        let result = client.search("test query").await;

        mock.assert_async().await;
        assert!(result.is_err());
        match result {
            Err(Error::Http(e)) => assert_eq!(e.status().unwrap().as_u16(), 500),
            _ => panic!("Expected HTTP error"),
        }
    }

    #[test]
    fn cql_escape_blocks_injection() {
        // A classic CQL injection: close the quoted string and inject a new
        // boolean clause.
        let malicious = r#"foo" OR cql.anywhere="bar"#;
        let escaped = cql_escape(malicious);
        // The closing `"` must be backslash-escaped so it cannot terminate the
        // outer quoted string.
        assert_eq!(escaped, r#"foo\" OR cql.anywhere=\"bar"#);
        // The result must not contain an unescaped double-quote that would
        // allow injection.
        let unescaped_quote_count = escaped
            .chars()
            .zip(std::iter::once('x').chain(escaped.chars()))
            .filter(|&(c, prev)| c == '"' && prev != '\\')
            .count();
        assert_eq!(
            unescaped_quote_count, 0,
            "escaped output must contain no unescaped double-quotes"
        );
    }

    #[test]
    fn cql_escape_strips_control_chars_and_grouping() {
        let input = "hello\x01\x1f(world)";
        let escaped = cql_escape(input);
        assert_eq!(escaped, "helloworld");
    }

    #[test]
    fn cql_escape_caps_at_200_chars() {
        let long = "a".repeat(300);
        assert_eq!(cql_escape(&long).len(), 200);
    }

    #[tokio::test]
    async fn test_search_response_too_large() {
        let mut server = mockito::Server::new_async().await;
        // Build a body that exceeds LOC_MAX_RESPONSE_BYTES.
        let big_body = vec![b'x'; LOC_MAX_RESPONSE_BYTES + 1];

        // Use Matcher::Any so the mock accepts the SRU request with query params.
        let mock = server
            .mock("GET", mockito::Matcher::Any)
            .with_status(200)
            .with_body(big_body)
            .create_async()
            .await;

        let client = LocClient::with_base_url(&server.url()).unwrap();
        let result = client.search("test").await;

        mock.assert_async().await;
        assert!(
            matches!(result, Err(Error::ResponseTooLarge(_))),
            "expected ResponseTooLarge, got {:?}",
            result
        );
    }

    #[test]
    fn lccn_valid_post2001_no_prefix() {
        // 10-digit post-2001 form
        assert!(is_valid_lccn("2001000002"), "10-digit should be valid");
    }

    #[test]
    fn lccn_valid_pre2001_with_alpha_prefix() {
        // 1-alpha + 8-digit normalised pre-2001 form
        assert!(is_valid_lccn("n97001234"), "1-alpha + 8-digit should be valid");
        // 2-alpha + 8-digit
        assert!(is_valid_lccn("nb97001234"), "2-alpha + 8-digit should be valid");
    }

    #[test]
    fn lccn_valid_boundary_digits() {
        // 8-digit minimum
        assert!(is_valid_lccn("97001234"), "8-digit no-prefix should be valid");
        // 10-digit maximum
        assert!(is_valid_lccn("2019012345"), "10-digit no-prefix should be valid");
    }

    #[test]
    fn lccn_rejects_path_traversal() {
        assert!(!is_valid_lccn("../foo"), "path traversal must be rejected");
        assert!(!is_valid_lccn("../../etc/passwd"), "deep traversal must be rejected");
    }

    #[test]
    fn lccn_rejects_plain_alpha() {
        // A string with only letters and no digits
        assert!(!is_valid_lccn("foo"), "alpha-only must be rejected");
    }

    #[test]
    fn lccn_rejects_spaces() {
        assert!(!is_valid_lccn("n 97001234"), "embedded space must be rejected");
    }

    #[test]
    fn lccn_rejects_empty() {
        assert!(!is_valid_lccn(""), "empty string must be rejected");
    }

    #[test]
    fn lccn_rejects_too_few_digits() {
        // 7 digits — one short of the 8-digit minimum
        assert!(!is_valid_lccn("9700123"), "7-digit must be rejected");
    }

    #[test]
    fn lccn_rejects_too_many_digits() {
        // 11 digits — one over the 10-digit maximum
        assert!(!is_valid_lccn("20190123456"), "11-digit must be rejected");
    }

    #[test]
    fn lccn_rejects_uppercase_prefix() {
        // LoC normalised form uses lowercase alpha prefix only
        assert!(!is_valid_lccn("N97001234"), "uppercase prefix must be rejected");
    }

    // ---- LCSH suggest2 adapter (search_lcsh_subject) -----------------------

    #[tokio::test]
    async fn search_lcsh_subject_parses_first_hit_alabel_and_uri() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/")
            .match_query(mockito::Matcher::UrlEncoded("q".into(), "Dragons".into()))
            .with_status(200)
            .with_body(
                r#"{"q":"Dragons","count":2,"hits":[
                    {"aLabel":"Dragons",
                     "uri":"http://id.loc.gov/authorities/subjects/sh85039287",
                     "suggestLabel":"Dragons","vLabel":"","sLabel":"",
                     "code":"","token":"sh85039287","rank":""},
                    {"aLabel":"Bearded dragons (Reptiles)",
                     "uri":"http://id.loc.gov/authorities/subjects/sh98005624",
                     "suggestLabel":"Dragons, Bearded (Reptiles)",
                     "vLabel":"Dragons, Bearded (Reptiles)","sLabel":"",
                     "code":"","token":"sh98005624","rank":""}
                ]}"#,
            )
            .create_async()
            .await;

        let client = LocClient::with_base_urls("http://localhost:0", &server.url()).unwrap();
        let matches = client.search_lcsh_subject("Dragons").await.unwrap();

        mock.assert_async().await;
        assert_eq!(matches.len(), 2);
        // First hit must use authoritative aLabel, NOT suggestLabel.
        assert_eq!(matches[0].label, "Dragons");
        assert_eq!(
            matches[0].uri,
            "http://id.loc.gov/authorities/subjects/sh85039287"
        );
        // Second hit's aLabel differs from its suggestLabel; verify we
        // pulled aLabel (the canonical USE-target).
        assert_eq!(matches[1].label, "Bearded dragons (Reptiles)");
    }

    #[tokio::test]
    async fn search_lcsh_subject_empty_term_short_circuits() {
        // No mock registered — empty term must not hit the network at
        // all, otherwise mockito's request-counting would catch us.
        let client = LocClient::with_base_urls(
            "http://localhost:0",
            "http://127.0.0.1:1",
        )
        .unwrap();
        for input in ["", " ", "\t\n  "] {
            let matches = client.search_lcsh_subject(input).await.unwrap();
            assert!(matches.is_empty(), "input {input:?} must short-circuit");
        }
    }

    #[tokio::test]
    async fn search_lcsh_subject_404_returns_empty_vec() {
        let mut server = mockito::Server::new_async().await;
        let _mock = server
            .mock("GET", mockito::Matcher::Any)
            .with_status(404)
            .create_async()
            .await;

        let client = LocClient::with_base_urls("http://localhost:0", &server.url()).unwrap();
        let matches = client.search_lcsh_subject("anything").await.unwrap();
        assert!(matches.is_empty(), "404 normalises to empty result");
    }

    #[tokio::test]
    async fn search_lcsh_subject_500_surfaces_error() {
        let mut server = mockito::Server::new_async().await;
        let _mock = server
            .mock("GET", mockito::Matcher::Any)
            .with_status(500)
            .create_async()
            .await;

        let client = LocClient::with_base_urls("http://localhost:0", &server.url()).unwrap();
        let result = client.search_lcsh_subject("anything").await;
        assert!(matches!(result, Err(Error::Http(_))));
    }

    #[tokio::test]
    async fn search_lcsh_subject_malformed_json_errors() {
        let mut server = mockito::Server::new_async().await;
        let _mock = server
            .mock("GET", mockito::Matcher::Any)
            .with_status(200)
            .with_body("not json {")
            .create_async()
            .await;

        let client = LocClient::with_base_urls("http://localhost:0", &server.url()).unwrap();
        let result = client.search_lcsh_subject("anything").await;
        assert!(matches!(result, Err(Error::Query(_))));
    }
}
