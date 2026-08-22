//! Strict I-JSON front-end + RFC 8785 (JCS) for the r402s/v0 **no-numbers** profile.
//!
//! Protocol §1: strict parsing rejects duplicate members, non-I-JSON, invalid
//! Unicode (lone surrogates, malformed UTF-8), and ANY JSON number. Canonical
//! JSON is RFC 8785; because the profile carries no numbers, JCS reduces to
//! UTF-16-code-unit member ordering plus the RFC's string escaping.
//!
//! This module is deliberately hand-written (no serde) so that the parser's
//! acceptance set is exactly the profile and nothing else.

use std::fmt;

/// A parsed JSON value. Objects keep their source member order so that a
/// non-canonical encoding can be detected by re-serializing and comparing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Null,
    Bool(bool),
    Str(String),
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>),
}

/// The strict-parse refusal reasons. The names are the protocol's vector
/// vocabulary (`vectors.json` class `strict-parse`, `expected.reason`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParseError {
    /// Any JSON number.
    JsonNumber,
    /// The same member name twice in one object.
    DuplicateMember,
    /// Not well-formed I-JSON (grammar, escapes, lone surrogates, invalid UTF-8).
    InvalidJson(String),
    /// Well-formed, but not byte-identical to its JCS form.
    NoncanonicalEncoding,
}

impl ParseError {
    pub fn reason(&self) -> &'static str {
        match self {
            ParseError::JsonNumber => "json-number",
            ParseError::DuplicateMember => "duplicate-member",
            ParseError::InvalidJson(_) => "invalid-json",
            ParseError::NoncanonicalEncoding => "noncanonical-encoding",
        }
    }
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ParseError::InvalidJson(d) => write!(f, "invalid-json: {d}"),
            other => f.write_str(other.reason()),
        }
    }
}

impl std::error::Error for ParseError {}

impl Value {
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_arr(&self) -> Option<&[Value]> {
        match self {
            Value::Arr(a) => Some(a),
            _ => None,
        }
    }
    pub fn as_obj(&self) -> Option<&[(String, Value)]> {
        match self {
            Value::Obj(m) => Some(m),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }
    /// `obj["k"]` as a string, or an error naming the member.
    pub fn str(&self, key: &str) -> Result<&str, String> {
        self.get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("missing string member `{key}`"))
    }
    /// `obj["k"]` (any value) or an error naming the member.
    pub fn req(&self, key: &str) -> Result<&Value, String> {
        self.get(key)
            .ok_or_else(|| format!("missing member `{key}`"))
    }
    /// A copy of this object without the named top-level member.
    pub fn without(&self, key: &str) -> Value {
        match self {
            Value::Obj(m) => Value::Obj(m.iter().filter(|(k, _)| k != key).cloned().collect()),
            other => other.clone(),
        }
    }
    /// A copy of this object with `key` set to `v` (replacing or appending).
    pub fn with(&self, key: &str, v: Value) -> Value {
        match self {
            Value::Obj(m) => {
                let mut out: Vec<(String, Value)> = m.clone();
                if let Some(slot) = out.iter_mut().find(|(k, _)| k == key) {
                    slot.1 = v;
                } else {
                    out.push((key.to_string(), v));
                }
                Value::Obj(out)
            }
            other => other.clone(),
        }
    }
    /// Build an object from pairs (convenience for AAD / content construction).
    pub fn obj(pairs: &[(&str, Value)]) -> Value {
        Value::Obj(
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        )
    }
    pub fn s(x: &str) -> Value {
        Value::Str(x.to_string())
    }
}

const MAX_DEPTH: usize = 64;

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn err<T>(&self, what: &str) -> Result<T, ParseError> {
        Err(ParseError::InvalidJson(format!(
            "{what} at byte {}",
            self.i
        )))
    }
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }
    fn ws(&mut self) {
        while let Some(c) = self.peek() {
            if c == b' ' || c == b'\t' || c == b'\n' || c == b'\r' {
                self.i += 1;
            } else {
                break;
            }
        }
    }
    fn expect(&mut self, lit: &[u8]) -> Result<(), ParseError> {
        if self.b[self.i..].starts_with(lit) {
            self.i += lit.len();
            Ok(())
        } else {
            self.err("unexpected token")
        }
    }
    fn value(&mut self, depth: usize) -> Result<Value, ParseError> {
        if depth > MAX_DEPTH {
            return self.err("nesting too deep");
        }
        self.ws();
        match self.peek() {
            None => self.err("unexpected end"),
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => Ok(Value::Str(self.string()?)),
            Some(b't') => {
                self.expect(b"true")?;
                Ok(Value::Bool(true))
            }
            Some(b'f') => {
                self.expect(b"false")?;
                Ok(Value::Bool(false))
            }
            Some(b'n') => {
                self.expect(b"null")?;
                Ok(Value::Null)
            }
            Some(c) if c == b'-' || c.is_ascii_digit() => Err(ParseError::JsonNumber),
            Some(_) => self.err("unexpected character"),
        }
    }
    fn object(&mut self, depth: usize) -> Result<Value, ParseError> {
        self.i += 1; // '{'
        let mut members: Vec<(String, Value)> = Vec::new();
        self.ws();
        if self.peek() == Some(b'}') {
            self.i += 1;
            return Ok(Value::Obj(members));
        }
        loop {
            self.ws();
            if self.peek() != Some(b'"') {
                return self.err("expected member name");
            }
            let k = self.string()?;
            self.ws();
            if self.peek() != Some(b':') {
                return self.err("expected ':'");
            }
            self.i += 1;
            let v = self.value(depth + 1)?;
            if members.iter().any(|(m, _)| *m == k) {
                return Err(ParseError::DuplicateMember);
            }
            members.push((k, v));
            self.ws();
            match self.peek() {
                Some(b',') => {
                    self.i += 1;
                }
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Value::Obj(members));
                }
                _ => return self.err("expected ',' or '}'"),
            }
        }
    }
    fn array(&mut self, depth: usize) -> Result<Value, ParseError> {
        self.i += 1; // '['
        let mut items = Vec::new();
        self.ws();
        if self.peek() == Some(b']') {
            self.i += 1;
            return Ok(Value::Arr(items));
        }
        loop {
            items.push(self.value(depth + 1)?);
            self.ws();
            match self.peek() {
                Some(b',') => {
                    self.i += 1;
                }
                Some(b']') => {
                    self.i += 1;
                    return Ok(Value::Arr(items));
                }
                _ => return self.err("expected ',' or ']'"),
            }
        }
    }
    fn hex4(&mut self) -> Result<u32, ParseError> {
        if self.i + 4 > self.b.len() {
            return self.err("truncated \\u escape");
        }
        let s = std::str::from_utf8(&self.b[self.i..self.i + 4])
            .map_err(|_| ParseError::InvalidJson("bad \\u escape".into()))?;
        let v = u32::from_str_radix(s, 16)
            .map_err(|_| ParseError::InvalidJson("bad \\u escape".into()))?;
        self.i += 4;
        Ok(v)
    }
    fn string(&mut self) -> Result<String, ParseError> {
        self.i += 1; // opening quote
        let mut out = String::new();
        loop {
            let c = match self.peek() {
                None => return self.err("unterminated string"),
                Some(c) => c,
            };
            match c {
                b'"' => {
                    self.i += 1;
                    return Ok(out);
                }
                b'\\' => {
                    self.i += 1;
                    let e = match self.peek() {
                        None => return self.err("unterminated escape"),
                        Some(e) => e,
                    };
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let cp = if (0xD800..0xDC00).contains(&hi) {
                                // high surrogate: a low surrogate MUST follow
                                if !self.b[self.i..].starts_with(b"\\u") {
                                    return self.err("lone high surrogate");
                                }
                                self.i += 2;
                                let lo = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return self.err("lone high surrogate");
                                }
                                0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                            } else if (0xDC00..0xE000).contains(&hi) {
                                return self.err("lone low surrogate");
                            } else {
                                hi
                            };
                            match char::from_u32(cp) {
                                Some(ch) => out.push(ch),
                                None => return self.err("invalid code point"),
                            }
                        }
                        _ => return self.err("invalid escape"),
                    }
                }
                0x00..=0x1F => return self.err("unescaped control character"),
                _ => {
                    // raw UTF-8 run: the whole document was validated as UTF-8 up front,
                    // so decode one scalar value here.
                    let rest = std::str::from_utf8(&self.b[self.i..])
                        .map_err(|_| ParseError::InvalidJson("invalid UTF-8".into()))?;
                    let ch = rest.chars().next().unwrap();
                    out.push(ch);
                    self.i += ch.len_utf8();
                }
            }
        }
    }
}

/// Parse I-JSON text under the no-numbers profile WITHOUT the canonical-bytes
/// check (used for the vector file itself and for pretty-printed inputs).
pub fn parse_lenient_layout(text: &[u8]) -> Result<Value, ParseError> {
    if std::str::from_utf8(text).is_err() {
        return Err(ParseError::InvalidJson("invalid UTF-8".into()));
    }
    if text.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Err(ParseError::InvalidJson("byte-order mark".into()));
    }
    let mut p = Parser { b: text, i: 0 };
    let v = p.value(0)?;
    p.ws();
    if p.i != text.len() {
        return p.err("trailing characters");
    }
    Ok(v)
}

/// The §1 strict-parse profile: lenient-layout parse PLUS the requirement that
/// the input bytes are exactly the JCS bytes of the parsed value.
pub fn strict_parse(text: &[u8]) -> Result<Value, ParseError> {
    let v = parse_lenient_layout(text)?;
    if jcs(&v) != text {
        return Err(ParseError::NoncanonicalEncoding);
    }
    Ok(v)
}

fn jcs_str(s: &str, out: &mut Vec<u8>) {
    out.push(b'"');
    for ch in s.chars() {
        match ch {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\u{8}' => out.extend_from_slice(b"\\b"),
            '\u{c}' => out.extend_from_slice(b"\\f"),
            '\n' => out.extend_from_slice(b"\\n"),
            '\r' => out.extend_from_slice(b"\\r"),
            '\t' => out.extend_from_slice(b"\\t"),
            c if (c as u32) < 0x20 => {
                out.extend_from_slice(format!("\\u{:04x}", c as u32).as_bytes());
            }
            c => {
                let mut buf = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    out.push(b'"');
}

fn utf16_key(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn ser(v: &Value, out: &mut Vec<u8>) {
    match v {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(true) => out.extend_from_slice(b"true"),
        Value::Bool(false) => out.extend_from_slice(b"false"),
        Value::Str(s) => jcs_str(s, out),
        Value::Arr(a) => {
            out.push(b'[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                ser(x, out);
            }
            out.push(b']');
        }
        Value::Obj(m) => {
            let mut items: Vec<&(String, Value)> = m.iter().collect();
            // RFC 8785 §3.2.3: sort by UTF-16 code units of the member name
            items.sort_by(|a, b| utf16_key(&a.0).cmp(&utf16_key(&b.0)));
            out.push(b'{');
            for (i, (k, x)) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                jcs_str(k, out);
                out.push(b':');
                ser(x, out);
            }
            out.push(b'}');
        }
    }
}

/// RFC 8785 canonical bytes of `v` (no-numbers profile).
pub fn jcs(v: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    ser(v, &mut out);
    out
}

/// Human-readable (indented) rendering, for CLI reports only — never for hashing.
pub fn pretty(v: &Value) -> String {
    fn go(v: &Value, ind: usize, out: &mut String) {
        let pad = "  ".repeat(ind);
        match v {
            Value::Arr(a) if !a.is_empty() => {
                out.push_str("[\n");
                for (i, x) in a.iter().enumerate() {
                    out.push_str(&pad);
                    out.push_str("  ");
                    go(x, ind + 1, out);
                    if i + 1 < a.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                out.push_str(&pad);
                out.push(']');
            }
            Value::Obj(m) if !m.is_empty() => {
                out.push_str("{\n");
                for (i, (k, x)) in m.iter().enumerate() {
                    out.push_str(&pad);
                    out.push_str("  ");
                    let mut kb = Vec::new();
                    jcs_str(k, &mut kb);
                    out.push_str(std::str::from_utf8(&kb).unwrap());
                    out.push_str(": ");
                    go(x, ind + 1, out);
                    if i + 1 < m.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                out.push_str(&pad);
                out.push('}');
            }
            other => out.push_str(std::str::from_utf8(&jcs(other)).unwrap()),
        }
    }
    let mut s = String::new();
    go(v, 0, &mut s);
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_rejected() {
        assert_eq!(strict_parse(b"{\"a\":1}"), Err(ParseError::JsonNumber));
        assert_eq!(strict_parse(b"[-0]"), Err(ParseError::JsonNumber));
    }

    #[test]
    fn duplicates_are_rejected() {
        assert_eq!(
            strict_parse(b"{\"a\":\"x\",\"a\":\"y\"}"),
            Err(ParseError::DuplicateMember)
        );
    }

    #[test]
    fn lone_surrogates_are_rejected() {
        assert!(matches!(
            strict_parse(b"\"\\ud800\""),
            Err(ParseError::InvalidJson(_))
        ));
        assert!(matches!(
            strict_parse(b"\"\\udc00\""),
            Err(ParseError::InvalidJson(_))
        ));
        // a proper pair is fine and canonicalizes to raw UTF-8
        assert_eq!(
            strict_parse("\"\u{1F600}\"".as_bytes()).unwrap(),
            Value::Str("\u{1F600}".into())
        );
    }

    #[test]
    fn canonical_order_is_utf16() {
        // RFC 8785 §3.2.3 example ordering: "\u{20ac}" (E2 82 AC) sorts before "\u{1F600}"
        // (surrogate pair D83D DE00) under UTF-16, although UTF-8 would order them the other way
        let v = Value::obj(&[("\u{1F600}", Value::Null), ("\u{20ac}", Value::Null)]);
        let c = String::from_utf8(jcs(&v)).unwrap();
        assert_eq!(c, "{\"\u{20ac}\":null,\"\u{1F600}\":null}");
    }

    #[test]
    fn noncanonical_layout_is_rejected() {
        assert_eq!(
            strict_parse(b"{\"b\":null,\"a\":null}"),
            Err(ParseError::NoncanonicalEncoding)
        );
        assert_eq!(
            strict_parse(b"{ \"a\":null}"),
            Err(ParseError::NoncanonicalEncoding)
        );
        assert_eq!(
            strict_parse(b"{\"a\":\"\\u0061\"}"),
            Err(ParseError::NoncanonicalEncoding)
        );
        assert!(strict_parse(b"{\"a\":\"\\u0001\"}").is_ok());
    }
}
