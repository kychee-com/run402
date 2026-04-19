"""Moltbook verification challenge solver."""
import re

from . import api


def collapse(s: str) -> str:
    return re.sub(r"(.)\1+", r"\1", s)


# Words that contain short number words as substrings
FALSE_POSITIVES = {
    "ten": [
        "often", "antenna", "antena", "listen", "gluten", "kitten", "eaten",
        "written", "intensity", "intense", "intens", "content", "tent",
        "sentence", "attention", "potential", "patent", "latent", "intent",
        "extent", "extend", "competent", "consistent", "persistent", "existent",
        "encounter", "encounters", "then", "whaten", "meters", "meter",
        "neuton", "neutons", "newton", "newtons",
        "fifteen", "thirteen", "fourteen", "sixteen", "seventeen", "eighteen", "nineteen",
        "minute", "minutes",
        "centimeter", "centimeters", "centimetre", "centimetres",
    ],
    "one": [
        "someone", "done", "gone", "none", "bone", "tone", "zone", "stone",
        "phone", "alone", "money", "honest", "component", "ozone", "drone",
        "clone", "throne", "opponent", "oneclaw", "onecla",
        "neoton", "oneoton", "onewoton", "newton", "neuton",
        "combined", "combine",
    ],
    "eight": ["weight", "height", "freight", "sleight"],
    "eighteen": ["eightnewton", "eightmeter", "eightknot"],
    "eleven": ["twelve", "twelvth"],
    "nine": [
        "canine", "feminine", "machine", "engine", "examine", "determine",
        "combine", "discipline", "doctrine", "medicine", "routine", "minute",
    ],
    "fifteen": ["fivenewton", "fivenewtons", "fiveknot", "fiveknots", "fivemeter", "fivemeters"],
    "nineteen": ["minute"],
    "six": ["sixth", "mixture", "physix", "physics"],
    "two": ["between", "network"],
    "three": [
        "there", "therefore", "another", "whether", "together", "other",
        "gather", "feather", "leather", "weather", "threat", "thread",
    ],
}

TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}
ONES = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9,
}
ALL_NUMS = {
    "zero": 0, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
    "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17,
    "eighteen": 18, "nineteen": 19, "hundred": 100,
    **ONES,
}


PHONETIC_ALTS = {
    "v": "[vf]", "f": "[fv]", "t": "[tds]", "d": "[dt]",
    "s": "[szt]", "z": "[zs]", "n": "[nm]", "m": "[mn]",
    "b": "[bp]", "p": "[pb]", "g": "[gk]", "k": "[kg]",
}


def _fuzzy_pattern(word: str, loose: bool = False) -> str:
    """Build regex that allows optional extra vowels and phonetic swaps.
    
    Allows skipping one interior character to handle obfuscation that
    drops characters after collapse (e.g. 'tWeNnY' → 'tweny' missing 't').
    Returns alternation: full pattern | each single-char-skip variant.
    
    If loose=True, allows up to 2 junk chars between expected chars (for number words).
    """
    chars = list(collapse(word))
    
    gap = "[a-z]{0,2}?" if loose else "[aeiou]?"
    
    def _build(chars_list):
        parts = []
        for c in chars_list:
            parts.append(PHONETIC_ALTS.get(c, re.escape(c)))
        return gap.join(parts)
    
    # Full pattern + variants with one interior char removed
    # Only generate skip variants for words with 7+ collapsed chars — too many false positives for shorter words
    variants = [_build(chars)]
    if len(chars) >= 6:
        for i in range(1, len(chars) - 1):
            variants.append(_build(chars[:i] + chars[i+1:]))
    return "(?:" + "|".join(variants) + ")"


def _extract_numbers(aj: str) -> list[float]:
    ct = {collapse(k): v for k, v in TENS.items()}
    co = {collapse(k): v for k, v in ONES.items()}
    ca = {collapse(k): v for k, v in ALL_NUMS.items()}

    found: list[tuple[int, int]] = []
    used: set[int] = set()

    def _find_all(pattern: str, text: str, pos: int = 0):
        """Yield (start, end) for all non-overlapping regex matches."""
        for m in re.finditer(pattern, text[pos:]):
            yield (pos + m.start(), pos + m.end())

    # Pass 1: tens+ones compounds (with fuzzy matching)
    for tw, tv in sorted(ct.items(), key=lambda x: -len(x[0])):
        pat = _fuzzy_pattern(list(TENS.keys())[list(TENS.values()).index(tv)], loose=True)
        for idx, after in _find_all(pat, aj):
            if any(p in used for p in range(idx, after)):
                continue
            matched = False
            # Try all ones and pick the closest (earliest) match
            best_ones = None  # (end_pos, value)
            for ow, ov in sorted(co.items(), key=lambda x: -len(x[0])):
                opat = _fuzzy_pattern(list(ONES.keys())[list(ONES.values()).index(ov)], loose=True)
                # Allow up to 5 junk chars between tens and ones (obfuscation artifacts)
                m = re.search(r'^.{0,5}?' + opat, aj[after:])
                if m:
                    candidate_end = after + m.end()
                    # Prefer shortest overall match (ones word closest to tens word)
                    if best_ones is None or m.end() < best_ones[4] or (m.end() == best_ones[4] and len(ow) > best_ones[2]):
                        best_ones = (m.start(), ov, len(ow), candidate_end, m.end())
            if best_ones:
                end = best_ones[3]
                found.append((idx, tv + best_ones[1]))
                used.update(range(idx, end))
                matched = True
            if not matched:
                found.append((idx, tv))
                used.update(range(idx, after))

    # Pass 2: standalone with false-positive filtering (with fuzzy matching)
    for w, v in sorted(ca.items(), key=lambda x: -len(x[0])):
        orig_word = [k for k, val in ALL_NUMS.items() if val == v][0]
        pat = _fuzzy_pattern(orig_word)
        for idx, end in _find_all(pat, aj):
            if any(p in used for p in range(idx, end)):
                continue
            is_fp = False
            # Check both collapsed key and original word for false positives
            fp_key = w if w in FALSE_POSITIVES else (orig_word if orig_word in FALSE_POSITIVES else None)
            if fp_key:
                for fpw in FALSE_POSITIVES[fp_key]:
                    fc = collapse(fpw)
                    for fs in range(max(0, idx - len(fc) + 1), idx + 1):
                        if aj[fs : fs + len(fc)] == fc:
                            is_fp = True
                            break
                    if is_fp:
                        break
            if not is_fp:
                found.append((idx, v))
                used.update(range(idx, end))

    # Pass 3: detect "and a half" / "and a quarter" / "point X" modifiers
    found.sort()
    updated = []
    remove_positions = set()  # positions of numbers absorbed by "point X"
    for i, (pos, v) in enumerate(found):
        if pos in remove_positions:
            continue
        next_pos = found[i + 1][0] if i + 1 < len(found) else len(aj)
        window = aj[pos:min(pos + 60, len(aj))]  # wider window for point detection
        if re.search(r"andahalf", window):
            v += 0.5
        elif re.search(r"andaquarter", window):
            v += 0.25
        else:
            # Handle "point X" decimals (e.g. "two point five" = 2.5)
            point_match = re.search(r"point", window)
            if point_match:
                after_point = window[point_match.end():]
                for dw, dv in sorted(ONES.items(), key=lambda x: -len(x[0])):
                    dp = _fuzzy_pattern(dw)
                    dm = re.match(r'.{0,3}?' + dp, after_point)
                    if dm:
                        v = float(int(v)) + dv * 0.1
                        # Remove the decimal digit if it was found as separate number
                        for j in range(i + 1, len(found)):
                            if found[j][1] == dv:
                                remove_positions.add(found[j][0])
                                break
                        break
        updated.append((pos, v))
    found = updated

    found.sort()
    # Deduplicate: if the same value appears multiple times within 30 chars,
    # it's likely the same number written in multiple obfuscated forms.
    deduped: list[tuple[int, float]] = []
    for pos, v in found:
        if deduped and deduped[-1][1] == v and pos - deduped[-1][0] < 30:
            continue  # skip duplicate nearby same value
        deduped.append((pos, v))
    return [v for _, v in deduped]


def _detect_operation(challenge: str, aj: str) -> str | None:
    # Check literal math operators in original text first (allow junk chars around operator)
    stripped = re.sub(r'[^a-zA-Z0-9+\-*/\s]', ' ', challenge)
    if re.search(r'\*', stripped):
        return "*"
    if re.search(r'\s\+\s', stripped):
        return "+"
    # Note: " / " and " - " skipped for literal detection — obfuscation uses
    # these chars as decoration too often, causing false positives.

    # Priority: explicit question phrase ("what is the sum/difference/product") overrides story keywords
    # Check for explicit "multiplied by" / "divided by" in the full text BEFORE question phrase
    aj_lower = aj  # already lowered+collapsed
    if "multipliedby" in aj_lower or "multiplyby" in aj_lower:
        return "*"
    if "dividedby" in aj_lower or "divideby" in aj_lower:
        return "/"

    # Check for explicit multiply/divide words BEFORE question phrase detection
    # (e.g. "multiplies by two, what is total force?" should be * not +)
    _aj_for_early = aj
    _has_explicit_multiply = any(
        collapse(w) in _aj_for_early or (len(collapse(w)) > 3 and re.search(_fuzzy_pattern(w), _aj_for_early))
        for w in ("multiply", "multiplied", "multiplies", "double", "doubles", "triple", "triples", "times")
    )
    _has_explicit_divide = any(
        collapse(w) in _aj_for_early
        for w in ("divided", "dividedby")
    )

    question_match = re.search(r'what\s*is\s*(the\s*)?(.*?)$', re.sub(r'[^a-zA-Z\s]', ' ', challenge).lower())
    if question_match:
        q = collapse(question_match.group(2))
        if "product" in q:
            return "*"
        if ("sum" in q or "total" in q or "combined" in q) and not _has_explicit_multiply and not _has_explicit_divide:
            return "+"
        if "difference" in q:
            return "-"

    # "net force" / "net X" → subtraction (physics), checked BEFORE general keyword scan
    if "netforce" in aj or "netpul" in aj or "netpush" in aj:
        return "-"
    # "the net" → subtraction, BUT not if explicit multiply keyword present
    if "thenet" in aj:
        # Check for explicit multiply keywords first
        _times_check = re.sub(r'[^a-z]', '', challenge.lower())
        if not any(kw in _times_check for kw in ("times", "multiply", "multiplied", "product", "factor")):
            return "-"
    # Word-based detection (subtraction before addition to avoid false matches)
    # Use fuzzy matching to handle obfuscation artifacts
    # False positives for operation keywords (word → list of containing words)
    op_false_positives = {
        "boost": ["lobster", "loboster"],
        "minus": ["minute", "minutes"],
        "times": ["centimeter", "centimetre", "centimeters", "centimetres", "sometimes", "lifetime", "bedtimes", "overtime", "halftime", "nighttime", "daytime", "meantime", "pastime"],
    }
    ops = [
        ("multiply", "*"), ("multiplied", "*"), ("multiplies", "*"), ("multipled", "*"), ("multiple", "*"),
        ("product", "*"), ("leverag", "*"), ("advantag", "*"),
        ("double", "*"), ("doubles", "*"), ("triple", "*"), ("triples", "*"),
        ("torque", "*"), ("factor", "*"), ("boost", "*"), ("amplif", "*"), ("magnif", "*"),
        ("loses", "-"), ("minus", "-"), ("slows", "-"), ("slower", "-"), ("drops", "-"),
        ("remains", "-"), ("remaining", "-"),
        ("reduces", "-"), ("reducing", "-"), ("subtract", "-"), ("decreased", "-"), ("reduced", "-"),
        ("times", "*"),
        ("sum", "+"), ("adds", "+"), ("add", "+"), ("plus", "+"),
        ("increases", "+"), ("gains", "+"), ("speeds", "+"), ("accelerat", "+"),
        ("divided", "/"),
    ]
    for word, op in ops:
        # Try exact collapsed match first, then fuzzy pattern match
        # Skip fuzzy matching for very short words (<=3 chars collapsed) — too many false positives
        cw = collapse(word)
        if cw in aj:
            matched = True
            m = None
        elif len(cw) > 3:
            m = re.search(_fuzzy_pattern(word), aj)
            matched = bool(m)
        else:
            matched = False
            m = None
        if matched:
            # Check for false positives (e.g. "boost" inside "lobster")
            fp_words = op_false_positives.get(word, [])
            is_fp = False
            for fpw in fp_words:
                if collapse(fpw) in aj:
                    is_fp = True
                    break
            if not is_fp:
                return op
    if "total" in aj:
        # "total" with per-unit language (force per claw, cost per item, etc.) → multiply
        # But NOT "exert" — "claw A exerts X, claw B exerts Y, total" = addition
        # Use cleaned alpha-only text to avoid false substring matches (e.g. "experiment" contains "per")
        clean = re.sub(r'[^a-zA-Z\s]', '', challenge).lower()
        if re.search(r"\b(per|each|every|produce|generate|yield)\b", clean):
            return "*"
        # "exerts X and has N claws" pattern = multiply (per-unit × count)
        if re.search(r"\bexerts?\b", clean) and re.search(r"\b(has|have|with|are)\b.*\b(claws?|legs?|arms?|limbs?)\b", clean):
            return "*"
        # "applies X ... shares with N" pattern = multiply (force applied across multiple)
        if re.search(r"\bappl(y|ies|ied)\b", clean) and re.search(r"\bshares?\b", clean):
            return "*"
        # "N lobsters grip together" / "N claws grip together" = per-unit × count
        if re.search(r"\b(grip|clamp|squeeze|pinch|crush)\b.*\btogether\b", clean):
            return "*"
        return "+"
    # Rate × time pattern: "per second/minute/hour for N seconds/minutes/hours"
    clean = re.sub(r'[^a-zA-Z\s]', '', challenge).lower()
    if re.search(r"\bper\s+(second|minute|hour|meter).*\bfor\b", clean, re.I):
        return "*"
    # "how far" with speed+time usually means multiply
    if "howfar" in aj and any(w in aj for w in ["persecond", "perminute", "perhour", "speed", "velocity"]):
        return "*"
    # "swims/runs/flies at X ... for Y" pattern (speed × time)
    if re.search(r"\b(swim|run|fl[iy]|walk|crawl|mov|trave?l|drive|sail|sprint|jog|gallop|dash)[a-z]*\b.*\bat\b.*\bfor\b", clean):
        return "*"
    # "how far" generic — if we have exactly 2 numbers and "how far", likely multiply
    if "howfar" in aj:
        return "*"
    # Physics: "how much work" = force × distance
    if "howmuchwork" in aj:
        return "*"
    # "applies X over Y" = force × distance (work)
    if "aplies" in aj or "applies" in aj or "aply" in aj:
        return "*"
    return None


def solve(result: dict) -> bool:
    """Extract verification challenge from API result, solve it, submit answer."""
    v = (
        (result.get("comment", {}) or {}).get("verification")
        or (result.get("post", {}) or {}).get("verification")
        or result.get("verification")
    )
    if not v:
        print("  No verification needed")
        return True

    code = v["verification_code"]
    challenge = v["challenge_text"]
    print(f"  Challenge: {challenge}")

    aj = collapse("".join(c.lower() for c in challenge if c.isalpha()))
    numbers = _extract_numbers(aj)
    op = _detect_operation(challenge, aj)

    print(f"  Numbers: {numbers} | Op: {op}")

    if len(numbers) >= 2 and op:
        if op in ("*", "/") and len(numbers) > 2:
            # When numbers repeat (e.g. [23, 14, 23, 14]), use the first two distinct values.
            # For physics-style problems, the question usually restates the operands at the end.
            seen = []
            for n in numbers:
                if n not in seen:
                    seen.append(n)
            a, b = seen[0], seen[1] if len(seen) >= 2 else numbers[1]
        else:
            a, b = numbers[0], numbers[1]
        if op == "+" and len(numbers) > 2:
            # Challenges often restate numbers — deduplicate for sums
            seen_vals = []
            for n in numbers:
                if n not in seen_vals:
                    seen_vals.append(n)
            ans = sum(seen_vals)
        else:
            ans = {"+": a + b, "-": a - b, "*": a * b, "/": a / b if b else 0}.get(op, a + b)
    elif len(numbers) >= 2:
        ans = sum(numbers)
    elif len(numbers) == 1:
        ans = numbers[0]
    else:
        print("  FAILED: no numbers found")
        return False

    answer = f"{ans:.2f}"
    print(f"  Answer: {answer}")
    r = api.verify(code, answer)
    ok = r.get("success", False)
    print(f"  {'VERIFIED' if ok else 'FAILED'}: {r.get('message', r.get('error', '?'))[:100]}")
    return ok
