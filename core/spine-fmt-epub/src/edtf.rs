//! EDTF Level-1 validator for `<dc:date>` literals.
//!
//! Per the S14 design review N1.5: the reader must validate `<dc:date>`
//! against the same EDTF Level-1 shape `AddInstanceDialog.tsx`
//! enforces frontend-side. Otherwise Spine can ingest a date the dialog
//! couldn't have produced — backend gate diverges from frontend gate.
//!
//! The grammar mirrors `apps/desktop/src/AddInstanceDialog.tsx:16-17`'s
//! `EDTF_L1` regex exactly:
//!
//! - `YYYY` (e.g. `2024`)
//! - `YYYY-MM` / `YYYY-MM-DD`
//! - any of the above with a single `?` / `~` / `%` qualifier
//! - open intervals `YYYY/YYYY` / `YYYY/..` / `../YYYY`
//! - unspecified `YYYX` / `YYXX` / `YXXX` / `XXXX`
//!
//! Plus the same Gregorian sanity check added in the W1 review
//! frontend-side: a 13th month or a 30th of February passes the regex
//! but isn't a real date — explicit `month <= 12` and round-trip via
//! `chrono`-equivalent day-of-month checks catch it.
//!
//! Hand-rolled (no regex crate) — the grammar is small enough that a
//! state-machine stays under 60 lines and avoids adding a workspace
//! dependency for one small validator.

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("malformed EDTF Level-1 date: {value:?} ({reason})")]
pub(crate) struct EdtfError {
    pub(crate) value: String,
    pub(crate) reason: &'static str,
}

/// Validate an EDTF Level-1 string. Empty input is OK (caller decides
/// whether to drop or keep).
pub(crate) fn validate_edtf_l1(raw: &str) -> Result<(), EdtfError> {
    let s = raw.trim();
    if s.is_empty() {
        return Ok(());
    }

    // Open-interval forms first (they don't conform to the YYYY-prefix shape).
    if let Some(rest) = s.strip_prefix("../") {
        return require_year(rest).map_err(|reason| err(raw, reason));
    }

    // Unspecified-XXXX forms.
    if matches!(s, "XXXX") {
        return Ok(());
    }
    if s.len() == 4 && s.ends_with("XXX") && first_char_is_digit(s) {
        return Ok(());
    }
    if s.len() == 4 && s.ends_with("XX") && first_two_are_digits(s) {
        return Ok(());
    }
    if s.len() == 4 && s.ends_with('X') && first_three_are_digits(s) {
        return Ok(());
    }

    // YYYY/YYYY or YYYY/..
    if let Some((left, right)) = s.split_once('/') {
        require_year(left).map_err(|reason| err(raw, reason))?;
        if right == ".." {
            return Ok(());
        }
        return require_year(right).map_err(|reason| err(raw, reason));
    }

    // YYYY[-MM[-DD]][?~%]
    let (date_part, _qualifier) = match s.chars().last() {
        Some(c) if matches!(c, '?' | '~' | '%') => (&s[..s.len() - 1], Some(c)),
        _ => (s, None),
    };

    parse_year_month_day(date_part).map_err(|reason| err(raw, reason))
}

fn parse_year_month_day(s: &str) -> Result<(), &'static str> {
    let mut parts = s.splitn(3, '-');
    let year_str = parts.next().ok_or("missing year")?;
    require_year(year_str)?;

    let Some(month_str) = parts.next() else {
        return Ok(());
    };
    require_two_digits(month_str)?;
    let month: u32 = month_str.parse().map_err(|_| "month not numeric")?;
    if month == 0 || month > 12 {
        return Err("month must be 01-12");
    }

    let Some(day_str) = parts.next() else {
        return Ok(());
    };
    require_two_digits(day_str)?;
    let day: u32 = day_str.parse().map_err(|_| "day not numeric")?;
    let year: i32 = year_str.parse().map_err(|_| "year not numeric")?;
    if !is_real_gregorian(year, month, day) {
        return Err("day is not a real Gregorian date");
    }
    Ok(())
}

fn require_year(s: &str) -> Result<(), &'static str> {
    if s.len() != 4 || !s.bytes().all(|b| b.is_ascii_digit()) {
        Err("year must be exactly 4 digits")
    } else {
        Ok(())
    }
}

fn require_two_digits(s: &str) -> Result<(), &'static str> {
    if s.len() != 2 || !s.bytes().all(|b| b.is_ascii_digit()) {
        Err("month/day must be exactly 2 digits")
    } else {
        Ok(())
    }
}

fn first_char_is_digit(s: &str) -> bool {
    s.bytes().next().is_some_and(|b| b.is_ascii_digit())
}

fn first_two_are_digits(s: &str) -> bool {
    let bs = s.as_bytes();
    bs.len() >= 2 && bs[0].is_ascii_digit() && bs[1].is_ascii_digit()
}

fn first_three_are_digits(s: &str) -> bool {
    let bs = s.as_bytes();
    bs.len() >= 3
        && bs[0].is_ascii_digit()
        && bs[1].is_ascii_digit()
        && bs[2].is_ascii_digit()
}

/// Days-per-month including a Gregorian-style leap year check
/// (matches the frontend's `isRealGregorianDate` round-trip).
fn is_real_gregorian(year: i32, month: u32, day: u32) -> bool {
    let dim = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => return false,
    };
    day >= 1 && day <= dim
}

fn err(value: &str, reason: &'static str) -> EdtfError {
    EdtfError {
        value: value.into(),
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[track_caller]
    fn ok(s: &str) {
        validate_edtf_l1(s).unwrap_or_else(|e| panic!("expected OK on {s:?}, got {e:?}"));
    }

    #[track_caller]
    fn bad(s: &str) {
        validate_edtf_l1(s).expect_err(&format!("expected Err on {s:?}"));
    }

    #[test]
    fn accepts_year_only() {
        ok("2024");
        ok("0001");
        ok("9999");
    }

    #[test]
    fn accepts_year_month_year_month_day() {
        ok("2024-04");
        ok("2024-04-25");
    }

    #[test]
    fn accepts_qualifiers() {
        ok("2024?");
        ok("2024-04~");
        ok("2024-04-25%");
    }

    #[test]
    fn accepts_open_intervals() {
        ok("2024/2026");
        ok("2024/..");
        ok("../2024");
    }

    #[test]
    fn accepts_unspecified() {
        ok("XXXX");
        ok("9XXX");
        ok("19XX");
        ok("198X");
    }

    #[test]
    fn rejects_negative_year() {
        bad("-2024");
    }

    #[test]
    fn rejects_y_prefixed_huge_year() {
        bad("Y20240");
    }

    #[test]
    fn rejects_three_digit_year() {
        bad("999");
    }

    #[test]
    fn rejects_invalid_month() {
        bad("2024-13");
    }

    #[test]
    fn rejects_february_30_in_non_leap() {
        bad("2023-02-29");
    }

    #[test]
    fn accepts_leap_day() {
        ok("2024-02-29");
        ok("2000-02-29");
    }

    #[test]
    fn rejects_centuries_not_div_400() {
        bad("1900-02-29");
    }

    #[test]
    fn rejects_apr_31() {
        bad("2024-04-31");
    }

    #[test]
    fn rejects_garbage() {
        bad("not-a-date");
        bad("2024-04-25-extra");
    }

    #[test]
    fn empty_string_is_ok() {
        ok("");
        ok("   ");
    }
}
