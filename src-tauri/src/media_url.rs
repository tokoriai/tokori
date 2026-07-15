//! Canonical media keys — the Rust twin of `src/lib/media/url.ts`.
//!
//! The Immersion library stores whatever link the user pasted; the
//! Companion extension reports progress for whatever URL is in the
//! address bar. Both reduce to the same **canonical media key** so
//! `/v1/media/progress` and `/v1/media/lookup` can match them:
//!
//!   yt:<videoId>        YouTube video (watch / shorts / live / embed / youtu.be)
//!   yt:pl:<listId>      YouTube playlist page (list without a specific video)
//!   nf:<id>             Netflix /watch/<id> or /title/<id>
//!   sp:<type>:<id>      Spotify episode/show
//!   ap:<showId>[:<ep>]  Apple Podcasts (episode when the `i` param is present)
//!   vimeo:<id>          Vimeo video
//!   bili:<id>           Bilibili /video/<id>
//!   web:<host>/<path>   Everything else — lowercased host (www. stripped,
//!                       non-default port kept), path without trailing slash,
//!                       query + fragment dropped
//!
//! The grammar is shared with the TypeScript side; the test vectors at
//! the bottom mirror `test/media-url.test.ts`. Change one, change both.

use url::Url;

/// YouTube ids are 11 chars today, but that's convention, not contract.
fn is_yt_id(s: &str) -> bool {
    (6..=20).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn is_scheme_prefix(s: &str) -> Option<usize> {
    let colon = s.find(':')?;
    let head = &s[..colon];
    let mut chars = head.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    if chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')) {
        Some(colon)
    } else {
        None
    }
}

fn parse_http_url(raw: &str) -> Option<Url> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    // Same scheme rules as the TS twin: "<scheme>://" parses as-is;
    // "<word>:<non-digit>" is a schemeful non-web URI (mailto:,
    // spotify:) and is rejected; everything else gets the https:// the
    // user didn't type. The digit test keeps bare "host:port/path" alive.
    let candidate = match is_scheme_prefix(s) {
        Some(colon) if s[colon..].starts_with("://") => s.to_string(),
        Some(colon) => {
            let after = s[colon + 1..].chars().next();
            if !matches!(after, Some(c) if c.is_ascii_digit()) {
                return None;
            }
            format!("https://{s}")
        }
        None => format!("https://{s}"),
    };
    let u = Url::parse(&candidate).ok()?;
    matches!(u.scheme(), "http" | "https").then_some(u)
}

/// Hostname with the noise prefixes dropped: `www.` always, plus the
/// mobile/music subdomains that alias the same content on the big
/// providers. Used for provider detection only.
fn core_host(u: &Url) -> String {
    let host = u.host_str().unwrap_or_default().to_lowercase();
    for prefix in ["www.", "m.", "music."] {
        if let Some(rest) = host.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    host
}

fn segments(u: &Url) -> Vec<String> {
    u.path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}

fn query_param(u: &Url, name: &str) -> Option<String> {
    u.query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

fn youtube_key(u: &Url, host: &str, segs: &[String]) -> Option<String> {
    if host == "youtu.be" {
        let id = segs.first()?;
        return is_yt_id(id).then(|| format!("yt:{id}"));
    }
    if let Some(v) = query_param(u, "v") {
        if is_yt_id(&v) {
            return Some(format!("yt:{v}"));
        }
    }
    if let (Some(first), Some(second)) = (segs.first(), segs.get(1)) {
        if matches!(first.as_str(), "shorts" | "live" | "embed") && is_yt_id(second) {
            return Some(format!("yt:{second}"));
        }
    }
    // watch?v=…&list=… is a video (handled above); /playlist?list=… is
    // the series itself.
    if segs.first().map(String::as_str) == Some("playlist") {
        if let Some(list) = query_param(u, "list") {
            return Some(format!("yt:pl:{list}"));
        }
    }
    None
}

/// Fallback identity: host + path, everything volatile stripped. A
/// non-default port is identity (self-hosted servers); `Url::port()`
/// is `None` for scheme defaults, matching WHATWG `URL.host`.
fn generic_key(u: &Url) -> String {
    let mut host = u.host_str().unwrap_or_default().to_lowercase();
    if let Some(rest) = host.strip_prefix("www.") {
        host = rest.to_string();
    }
    if let Some(port) = u.port() {
        host = format!("{host}:{port}");
    }
    let path = u.path().trim_end_matches('/');
    format!("web:{host}{path}")
}

/// Reduce a URL to its canonical media identity. `None` for strings
/// that aren't http(s) URLs at all.
pub fn canonical_media_key(raw: &str) -> Option<String> {
    let u = parse_http_url(raw)?;
    let host = core_host(&u);
    let segs = segments(&u);

    if host == "youtube.com" || host == "youtu.be" || host == "youtube-nocookie.com" {
        // Channel pages, search results, … fall through to the generic key.
        return Some(youtube_key(&u, &host, &segs).unwrap_or_else(|| generic_key(&u)));
    }

    if host == "netflix.com" {
        if let (Some(first), Some(second)) = (segs.first(), segs.get(1)) {
            if matches!(first.as_str(), "watch" | "title")
                && !second.is_empty()
                && second.chars().all(|c| c.is_ascii_digit())
            {
                return Some(format!("nf:{second}"));
            }
        }
        return Some(generic_key(&u));
    }

    if host == "open.spotify.com" || host == "spotify.com" {
        // Locale prefix (`/intl-de/…`) aliases the same content.
        let s: &[String] = if segs.first().is_some_and(|p| p.starts_with("intl-")) {
            &segs[1..]
        } else {
            &segs
        };
        if let (Some(first), Some(second)) = (s.first(), s.get(1)) {
            if matches!(first.as_str(), "episode" | "show") {
                return Some(format!("sp:{first}:{second}"));
            }
        }
        return Some(generic_key(&u));
    }

    if host == "podcasts.apple.com" {
        // …/podcast/<slug>/id<digits>[?i=<episode>]
        if let Some(id_seg) = segs.iter().find(|seg| {
            seg.len() > 2 && seg.starts_with("id") && seg[2..].chars().all(|c| c.is_ascii_digit())
        }) {
            let show = &id_seg[2..];
            return Some(match query_param(&u, "i") {
                Some(ep) => format!("ap:{show}:{ep}"),
                None => format!("ap:{show}"),
            });
        }
        return Some(generic_key(&u));
    }

    if host == "vimeo.com" {
        if let Some(first) = segs.first() {
            if !first.is_empty() && first.chars().all(|c| c.is_ascii_digit()) {
                return Some(format!("vimeo:{first}"));
            }
        }
    }

    if host == "bilibili.com" && segs.first().map(String::as_str) == Some("video") {
        if let Some(id) = segs.get(1) {
            return Some(format!("bili:{id}"));
        }
    }

    Some(generic_key(&u))
}

#[cfg(test)]
mod tests {
    use super::canonical_media_key;

    /// Mirror of the KEY_VECTORS table in `test/media-url.test.ts`.
    #[test]
    fn key_vectors_match_the_ts_twin() {
        let vectors: &[(&str, &str)] = &[
            (
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                "yt:dQw4w9WgXcQ",
            ),
            ("https://youtu.be/dQw4w9WgXcQ?t=42", "yt:dQw4w9WgXcQ"),
            (
                "https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxyz",
                "yt:dQw4w9WgXcQ",
            ),
            (
                "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
                "yt:dQw4w9WgXcQ",
            ),
            ("youtube.com/shorts/dQw4w9WgXcQ/", "yt:dQw4w9WgXcQ"),
            (
                "https://www.youtube.com/live/dQw4w9WgXcQ?feature=share",
                "yt:dQw4w9WgXcQ",
            ),
            (
                "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
                "yt:dQw4w9WgXcQ",
            ),
            (
                "https://www.youtube.com/playlist?list=PLabcDEF123",
                "yt:pl:PLabcDEF123",
            ),
            (
                "https://www.youtube.com/@somechannel/videos",
                "web:youtube.com/@somechannel/videos",
            ),
            (
                "https://www.netflix.com/watch/81091393?trackId=14170286",
                "nf:81091393",
            ),
            ("https://www.netflix.com/title/80057281", "nf:80057281"),
            (
                "https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk",
                "sp:episode:4rOoJ6Egrf8K2IrywzwOMk",
            ),
            (
                "https://open.spotify.com/intl-de/show/2mTUnDkuKUkhiueKcVWoP0?si=abc",
                "sp:show:2mTUnDkuKUkhiueKcVWoP0",
            ),
            (
                "https://podcasts.apple.com/us/podcast/some-show/id123456789?i=1000634",
                "ap:123456789:1000634",
            ),
            (
                "https://podcasts.apple.com/de/podcast/some-show/id123456789",
                "ap:123456789",
            ),
            ("https://vimeo.com/76979871", "vimeo:76979871"),
            (
                "https://www.bilibili.com/video/BV1GJ411x7h7?p=2",
                "bili:BV1GJ411x7h7",
            ),
            (
                "https://example.com/shows/my-show/",
                "web:example.com/shows/my-show",
            ),
            ("example.com/a?q=1#frag", "web:example.com/a"),
            (
                "localhost:8096/web/index.html",
                "web:localhost:8096/web/index.html",
            ),
            (
                "HTTPS://WWW.EXAMPLE.COM/Mixed/Case",
                "web:example.com/Mixed/Case",
            ),
        ];
        for (url, key) in vectors {
            assert_eq!(
                canonical_media_key(url).as_deref(),
                Some(*key),
                "vector: {url}"
            );
        }
    }

    #[test]
    fn non_web_inputs_are_rejected() {
        for junk in [
            "",
            "   ",
            "My Great Show",
            "mailto:x@y.example",
            "file:///tmp/x.mp4",
            "spotify:episode:abc",
        ] {
            assert_eq!(canonical_media_key(junk), None, "input: {junk}");
        }
    }

    #[test]
    fn malformed_youtube_ids_fall_through_to_generic() {
        assert_eq!(
            canonical_media_key("https://www.youtube.com/watch?v=bad id!").as_deref(),
            Some("web:youtube.com/watch"),
        );
    }
}
