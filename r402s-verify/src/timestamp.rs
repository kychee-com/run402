//! RFC 3339 UTC millisecond timestamps, parsed SEMANTICALLY (protocol §1 /
//! D187): the pattern bounds the fields; the parser rejects impossible
//! calendar instants (`2026-02-31`, a Feb 29 outside a leap year).

/// Milliseconds since the Unix epoch, for arithmetic on a virtual clock.
pub fn parse_ms(s: &str) -> Result<i64, String> {
    let b = s.as_bytes();
    if b.len() != 24 {
        return Err(format!("timestamp length {} != 24", b.len()));
    }
    let d = |i: usize| -> Result<i64, String> {
        match b[i] {
            c @ b'0'..=b'9' => Ok((c - b'0') as i64),
            _ => Err(format!("non-ASCII-digit at {i}")),
        }
    };
    let num = |from: usize, n: usize| -> Result<i64, String> {
        let mut v = 0i64;
        for i in from..from + n {
            v = v * 10 + d(i)?;
        }
        Ok(v)
    };
    for (i, c) in [
        (4, b'-'),
        (7, b'-'),
        (10, b'T'),
        (13, b':'),
        (16, b':'),
        (19, b'.'),
        (23, b'Z'),
    ] {
        if b[i] != c {
            return Err(format!("expected {:?} at {i}", c as char));
        }
    }
    let (y, mo, da) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (h, mi, se, ms) = (num(11, 2)?, num(14, 2)?, num(17, 2)?, num(20, 3)?);
    if !(1..=12).contains(&mo) {
        return Err("month out of range".into());
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let mdays = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ][(mo - 1) as usize];
    if !(1..=mdays).contains(&da) {
        return Err("day out of range for month".into());
    }
    if h > 23 || mi > 59 || se > 59 {
        return Err("time out of range".into());
    }
    let days = days_from_civil(y, mo, da);
    Ok(((days * 86400 + h * 3600 + mi * 60 + se) * 1000) + ms)
}

/// Howard Hinnant's days_from_civil (proleptic Gregorian).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn format_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, mo, d) = civil_from_days(days);
    let (h, mi, s, mss) = (
        rem / 3_600_000,
        (rem / 60_000) % 60,
        (rem / 1000) % 60,
        rem % 1000,
    );
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{mss:03}Z")
}

pub fn is_calendar_valid(s: &str) -> bool {
    parse_ms(s).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_calendar() {
        let t = "2026-08-20T12:00:00.000Z";
        assert_eq!(format_ms(parse_ms(t).unwrap()), t);
        assert_eq!(parse_ms("1970-01-01T00:00:00.000Z").unwrap(), 0);
        assert!(parse_ms("2026-02-31T00:00:00.000Z").is_err());
        assert!(parse_ms("2025-02-29T00:00:00.000Z").is_err());
        assert!(parse_ms("2024-02-29T00:00:00.000Z").is_ok());
        assert!(parse_ms("2100-02-29T00:00:00.000Z").is_err());
        assert!(parse_ms("2000-02-29T00:00:00.000Z").is_ok());
        // Unicode digits are rejected at the byte frontier (D187)
        assert!(parse_ms("\u{0662}026-08-20T12:00:00.000Z").is_err());
        assert_eq!(
            format_ms(parse_ms("2026-01-03T00:00:00.000Z").unwrap() + 90 * 86_400_000),
            "2026-04-03T00:00:00.000Z"
        );
    }
}
