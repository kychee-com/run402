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
    ],
    "one": [
        "someone", "done", "gone", "none", "bone", "tone", "zone", "stone",
        "phone", "alone", "money", "honest", "component", "ozone", "drone",
        "clone", "throne",
    ],
    "eight": ["weight", "height", "freight", "sleight"],
    "nine": [
        "canine", "feminine", "machine", "engine", "examine", "determine",
        "combine", "discipline", "doctrine", "medicine", "routine",
    ],
    "six": ["sixth", "mixture"],
    "two": ["between", "network"],
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


def _fuzzy_pattern(word: str) -> str:
    """Build regex that allows optional extra vowels between each char of word."""
    return "[aeiou]?".join(re.escape(c) for c in collapse(word))


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
            for ow, ov in sorted(co.items(), key=lambda x: -len(x[0])):
                opat = _fuzzy_pattern(list(ONES.keys())[list(ONES.values()).index(ov)])
                m = re.match(opat, aj[after:])
                if m:
                    end = after + m.end()
                    found.append((idx, tv + ov))
                    used.update(range(idx, end))
                    matched = True
                    break
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
            if w in FALSE_POSITIVES:
                for fpw in FALSE_POSITIVES[w]:
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
    ops = [
        ("multiply", "*"), ("multiplied", "*"), ("multiplies", "*"), ("times", "*"),
        ("product", "*"), ("leverag", "*"), ("advantag", "*"),
        ("double", "*"), ("doubles", "*"), ("triple", "*"), ("triples", "*"),
        ("torque", "*"),
        ("loses", "-"), ("minus", "-"), ("slows", "-"), ("drops", "-"),
        ("remains", "-"),
        ("reduces", "-"), ("subtract", "-"), ("decreased", "-"), ("reduced", "-"),
        ("adds", "+"), ("add", "+"), ("plus", "+"),
        ("increases", "+"), ("gains", "+"), ("speeds", "+"),
        ("divided", "/"),
    ]
    for word, op in ops:
        if collapse(word) in aj:
            return op
    if "total" in aj:
        return "+"
    # Rate × time pattern: "per second/minute/hour for N seconds/minutes/hours"
    if re.search(r"per\s+(second|minute|hour|meter).*\bfor\b", challenge, re.I):
        return "*"
    # "how far" with speed+time usually means multiply
    if "how far" in challenge.lower() and any(w in challenge.lower() for w in ["per second", "per minute", "per hour", "speed", "velocity"]):
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
        a, b = numbers[0], numbers[1]
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
