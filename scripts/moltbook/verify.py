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
    ],
    "one": [
        "someone", "done", "gone", "none", "bone", "tone", "zone", "stone",
        "phone", "alone", "money", "honest", "component", "ozone", "drone",
        "clone", "throne", "opponent", "oneclaw",
    ],
    "eight": ["weight", "height", "freight", "sleight"],
    "nine": [
        "canine", "feminine", "machine", "engine", "examine", "determine",
        "combine", "discipline", "doctrine", "medicine", "routine",
    ],
    "six": ["sixth", "mixture"],
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


def _fuzzy_pattern(word: str) -> str:
    """Build regex that allows optional extra vowels and phonetic swaps."""
    parts = []
    for c in collapse(word):
        parts.append(PHONETIC_ALTS.get(c, re.escape(c)))
    return "[aeiou]?".join(parts)


def _extract_numbers(aj: str) -> list[int]:
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
        pat = _fuzzy_pattern(list(TENS.keys())[list(TENS.values()).index(tv)])
        for idx, after in _find_all(pat, aj):
            if any(p in used for p in range(idx, after)):
                continue
            matched = False
            # Try all ones and pick the closest (earliest) match
            best_ones = None  # (end_pos, value)
            for ow, ov in sorted(co.items(), key=lambda x: -len(x[0])):
                opat = _fuzzy_pattern(list(ONES.keys())[list(ONES.values()).index(ov)])
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

    found.sort()
    return [v for _, v in found]


def _detect_operation(challenge: str, aj: str) -> str | None:
    # Check literal math operators in original text first
    if " * " in challenge:
        return "*"
    if " + " in challenge:
        return "+"
    # Note: " / " and " - " skipped for literal detection — obfuscation uses
    # these chars as decoration too often, causing false positives.

    # Word-based detection (subtraction before addition to avoid false matches)
    # Use fuzzy matching to handle obfuscation artifacts
    # False positives for operation keywords (word → list of containing words)
    op_false_positives = {
        "boost": ["lobster", "loboster"],
    }
    ops = [
        ("multiply", "*"), ("multiplied", "*"), ("multiplies", "*"), ("multipled", "*"), ("multiple", "*"),
        ("product", "*"), ("leverag", "*"), ("advantag", "*"),
        ("double", "*"), ("doubles", "*"), ("triple", "*"), ("triples", "*"),
        ("torque", "*"), ("factor", "*"), ("boost", "*"), ("amplif", "*"), ("magnif", "*"),
        ("loses", "-"), ("minus", "-"), ("slows", "-"), ("slower", "-"), ("drops", "-"),
        ("remains", "-"), ("remaining", "-"),
        ("reduces", "-"), ("reducing", "-"), ("subtract", "-"), ("decreased", "-"), ("reduced", "-"),
        ("adds", "+"), ("add", "+"), ("plus", "+"),
        ("increases", "+"), ("gains", "+"), ("speeds", "+"),
        ("times", "*"),
        ("divided", "/"),
    ]
    for word, op in ops:
        # Try exact collapsed match first, then fuzzy pattern match
        m = re.search(_fuzzy_pattern(word), aj) if collapse(word) not in aj else None
        matched = collapse(word) in aj or m
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
        if re.search(r"\bexerts?\b", clean) and re.search(r"\b(has|have|with)\b.*\b(claws?|legs?|arms?|limbs?)\b", clean):
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
            # "multiplies by X" / "divides by X" — use first and last number
            a, b = numbers[0], numbers[-1]
        else:
            a, b = numbers[0], numbers[1]
        if op == "+" and len(numbers) > 2:
            ans = sum(numbers)
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
