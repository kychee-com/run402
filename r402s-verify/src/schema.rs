//! A deliberately SMALL JSON-Schema (draft 2020-12) evaluator covering exactly
//! the keyword subset the r402s/v0 schema set uses: `$ref` (same-document
//! `#/$defs/x`, sibling-file `name.json`, and `name.json#/$defs/x`), `type`,
//! `const`, `enum`, `pattern`, `minLength`/`maxLength`, `properties`,
//! `required`, `additionalProperties`, `items`, `minItems`/`maxItems`,
//! `uniqueItems`, `propertyNames`, `maxProperties`, `oneOf`, `allOf`,
//! `if`/`then`/`else`. Any other validation keyword is an error (fail closed)
//! rather than silently ignored.
//!
//! The schema documents carry JSON numbers (`maxItems: 64`), so they are
//! loaded with `serde_json`; INSTANCES are always the strict `json::Value`.

use crate::json::{jcs, Value};
use fancy_regex::Regex;
use serde_json::Value as S;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Mutex;

pub struct SchemaSet {
    docs: BTreeMap<String, S>,
    regex_cache: Mutex<HashMap<String, Regex>>,
}

const KNOWN: &[&str] = &[
    "$schema",
    "$id",
    "title",
    "description",
    "x-r402s-revision",
    "$defs",
    "$ref",
    "type",
    "const",
    "enum",
    "pattern",
    "minLength",
    "maxLength",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minItems",
    "maxItems",
    "uniqueItems",
    "propertyNames",
    "maxProperties",
    "oneOf",
    "allOf",
    "if",
    "then",
    "else",
];

impl SchemaSet {
    /// Load every `*.json` carrying `$schema` from a directory.
    pub fn load_dir(dir: &Path) -> Result<Self, String> {
        let mut docs = BTreeMap::new();
        let rd = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        for ent in rd {
            let p = ent.map_err(|e| e.to_string())?.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let text = std::fs::read(&p).map_err(|e| format!("{}: {e}", p.display()))?;
            let doc: S =
                serde_json::from_slice(&text).map_err(|e| format!("{}: {e}", p.display()))?;
            if doc.get("$schema").is_some() {
                let name = p.file_name().unwrap().to_string_lossy().to_string();
                docs.insert(name, doc);
            }
        }
        if docs.is_empty() {
            return Err(format!("no JSON-Schema documents in {}", dir.display()));
        }
        Ok(SchemaSet {
            docs,
            regex_cache: Mutex::new(HashMap::new()),
        })
    }

    pub fn has(&self, name: &str) -> bool {
        self.docs.contains_key(name)
    }

    pub fn doc(&self, name: &str) -> Option<&S> {
        self.docs.get(name)
    }

    /// `x-r402s-revision` of a document (the schema set's protocol revision stamp).
    pub fn revision(&self, name: &str) -> Option<String> {
        self.docs
            .get(name)?
            .get("x-r402s-revision")?
            .as_str()
            .map(String::from)
    }

    /// Validate `inst` against the top-level document `name` (e.g. `head.json`).
    pub fn is_valid(&self, name: &str, inst: &Value) -> Result<bool, String> {
        let doc = self
            .docs
            .get(name)
            .ok_or_else(|| format!("unknown schema {name}"))?;
        self.eval(doc, name, inst)
    }

    fn resolve<'a>(&'a self, base: &str, r: &str) -> Result<(&'a S, String), String> {
        let (file, frag) = match r.split_once('#') {
            Some((f, frag)) => (f, Some(frag)),
            None => (r, None),
        };
        let file = if file.is_empty() {
            base.to_string()
        } else {
            file.to_string()
        };
        let doc = self
            .docs
            .get(&file)
            .ok_or_else(|| format!("$ref to unknown document {file}"))?;
        let mut cur = doc;
        if let Some(frag) = frag {
            for seg in frag
                .trim_start_matches('/')
                .split('/')
                .filter(|s| !s.is_empty())
            {
                cur = cur
                    .get(seg)
                    .ok_or_else(|| format!("$ref {r}: no member {seg}"))?;
            }
        }
        Ok((cur, file))
    }

    fn regex_match(&self, pat: &str, s: &str) -> Result<bool, String> {
        let mut cache = self.regex_cache.lock().unwrap();
        if !cache.contains_key(pat) {
            let re = Regex::new(pat).map_err(|e| format!("pattern {pat:?}: {e}"))?;
            cache.insert(pat.to_string(), re);
        }
        cache[pat]
            .is_match(s)
            .map_err(|e| format!("pattern {pat:?}: {e}"))
    }

    fn const_eq(c: &S, v: &Value) -> bool {
        match (c, v) {
            (S::Null, Value::Null) => true,
            (S::Bool(a), Value::Bool(b)) => a == b,
            (S::String(a), Value::Str(b)) => a == b,
            (S::Array(a), Value::Arr(b)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(x, y)| Self::const_eq(x, y))
            }
            (S::Object(a), Value::Obj(b)) => {
                a.len() == b.len()
                    && b.iter()
                        .all(|(k, y)| a.get(k).map(|x| Self::const_eq(x, y)).unwrap_or(false))
            }
            _ => false, // a numeric const can never equal a profile value
        }
    }

    fn eval(&self, schema: &S, base: &str, inst: &Value) -> Result<bool, String> {
        let obj = match schema {
            S::Bool(b) => return Ok(*b),
            S::Object(o) => o,
            _ => return Err("schema is not an object".into()),
        };
        for k in obj.keys() {
            if !KNOWN.contains(&k.as_str()) {
                return Err(format!("unsupported schema keyword {k:?} (fail closed)"));
            }
        }
        if let Some(S::String(r)) = obj.get("$ref") {
            let (target, file) = self.resolve(base, r)?;
            if !self.eval(target, &file, inst)? {
                return Ok(false);
            }
        }
        if let Some(t) = obj.get("type") {
            let types: Vec<&str> = match t {
                S::String(s) => vec![s.as_str()],
                S::Array(a) => a.iter().filter_map(|x| x.as_str()).collect(),
                _ => return Err("bad type keyword".into()),
            };
            let ok = types.iter().any(|t| {
                matches!(
                    (*t, inst),
                    ("null", Value::Null)
                        | ("boolean", Value::Bool(_))
                        | ("string", Value::Str(_))
                        | ("array", Value::Arr(_))
                        | ("object", Value::Obj(_))
                )
            });
            if !ok {
                return Ok(false);
            }
        }
        if let Some(c) = obj.get("const") {
            if !Self::const_eq(c, inst) {
                return Ok(false);
            }
        }
        if let Some(S::Array(e)) = obj.get("enum") {
            if !e.iter().any(|c| Self::const_eq(c, inst)) {
                return Ok(false);
            }
        }
        if let Value::Str(s) = inst {
            if let Some(S::String(p)) = obj.get("pattern") {
                if !self.regex_match(p, s)? {
                    return Ok(false);
                }
            }
            let n = s.chars().count() as u64;
            if let Some(m) = obj.get("minLength").and_then(S::as_u64) {
                if n < m {
                    return Ok(false);
                }
            }
            if let Some(m) = obj.get("maxLength").and_then(S::as_u64) {
                if n > m {
                    return Ok(false);
                }
            }
        }
        if let Value::Arr(a) = inst {
            if let Some(m) = obj.get("minItems").and_then(S::as_u64) {
                if (a.len() as u64) < m {
                    return Ok(false);
                }
            }
            if let Some(m) = obj.get("maxItems").and_then(S::as_u64) {
                if (a.len() as u64) > m {
                    return Ok(false);
                }
            }
            if obj.get("uniqueItems") == Some(&S::Bool(true)) {
                let mut seen: Vec<Vec<u8>> = Vec::new();
                for x in a {
                    let c = jcs(x);
                    if seen.contains(&c) {
                        return Ok(false);
                    }
                    seen.push(c);
                }
            }
            if let Some(it) = obj.get("items") {
                for x in a {
                    if !self.eval(it, base, x)? {
                        return Ok(false);
                    }
                }
            }
        }
        if let Value::Obj(m) = inst {
            if let Some(mx) = obj.get("maxProperties").and_then(S::as_u64) {
                if (m.len() as u64) > mx {
                    return Ok(false);
                }
            }
            if let Some(S::Array(req)) = obj.get("required") {
                for r in req {
                    let r = r.as_str().ok_or("bad required")?;
                    if !m.iter().any(|(k, _)| k == r) {
                        return Ok(false);
                    }
                }
            }
            let props = obj.get("properties").and_then(S::as_object);
            if let Some(props) = props {
                for (k, sub) in props {
                    if let Some((_, v)) = m.iter().find(|(kk, _)| kk == k) {
                        if !self.eval(sub, base, v)? {
                            return Ok(false);
                        }
                    }
                }
            }
            if let Some(ap) = obj.get("additionalProperties") {
                for (k, v) in m {
                    if props.map(|p| p.contains_key(k)).unwrap_or(false) {
                        continue;
                    }
                    if !self.eval(ap, base, v)? {
                        return Ok(false);
                    }
                }
            }
            if let Some(pn) = obj.get("propertyNames") {
                for (k, _) in m {
                    if !self.eval(pn, base, &Value::Str(k.clone()))? {
                        return Ok(false);
                    }
                }
            }
        }
        if let Some(S::Array(all)) = obj.get("allOf") {
            for s in all {
                if !self.eval(s, base, inst)? {
                    return Ok(false);
                }
            }
        }
        if let Some(S::Array(one)) = obj.get("oneOf") {
            let mut n = 0;
            for s in one {
                if self.eval(s, base, inst)? {
                    n += 1;
                }
            }
            if n != 1 {
                return Ok(false);
            }
        }
        if let Some(cond) = obj.get("if") {
            let branch = if self.eval(cond, base, inst)? {
                obj.get("then")
            } else {
                obj.get("else")
            };
            if let Some(b) = branch {
                if !self.eval(b, base, inst)? {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }
}
