const TOKEN_CHARACTERS = new Set(
  "!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
);
const TOKEN68_BASE_CHARACTERS = new Set(
  "-._~+/0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
);

export const RFC9110_AUTH_LIMITS = Object.freeze({
  maxFieldLines: 16,
  maxAggregateBytes: 32_768,
  maxChallenges: 64,
  maxParamsPerChallenge: 32,
  maxTokenCharacters: 1_024,
});

export interface AuthenticationParameter {
  name: string;
  normalizedName: string;
  value: string;
  rawValue: string;
  raw: string;
}

export interface AuthenticationChallenge {
  scheme: string;
  normalizedScheme: string;
  token68: string | null;
  params: AuthenticationParameter[];
  lineIndex: number;
  start: number;
  end: number;
  raw: string;
}

export interface AuthenticationFieldLimits {
  maxFieldLines: number;
  maxAggregateBytes: number;
  maxChallenges: number;
  maxParamsPerChallenge: number;
  maxTokenCharacters: number;
}

export class AuthenticationFieldError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AuthenticationFieldError";
  }
}

function fail(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new AuthenticationFieldError(code, message, details);
}

function isOws(character: string | undefined): boolean {
  return character === " " || character === "\t";
}

function trimOwsEnd(value: string, start: number, end: number): number {
  let cursor = end;
  while (cursor > start && isOws(value[cursor - 1])) cursor -= 1;
  return cursor;
}

function validateFieldLine(line: string, lineIndex: number): void {
  for (let index = 0; index < line.length; index += 1) {
    const code = line.charCodeAt(index);
    if (code > 0xff || code === 0x7f || (code < 0x20 && code !== 0x09)) {
      fail("field_character_invalid", "authentication field contains an invalid character", {
        lineIndex,
        offset: index,
      });
    }
  }
}

class LineParser {
  private index = 0;
  private readonly challenges: AuthenticationChallenge[] = [];

  constructor(
    private readonly line: string,
    private readonly lineIndex: number,
    private readonly limits: AuthenticationFieldLimits,
  ) {}

  private skipOws(): void {
    while (this.index < this.line.length && isOws(this.line[this.index])) this.index += 1;
  }

  private parseToken(context: string): string {
    const start = this.index;
    while (this.index < this.line.length && TOKEN_CHARACTERS.has(this.line[this.index]!)) {
      this.index += 1;
      if (this.index - start > this.limits.maxTokenCharacters) {
        fail("token_length_limit_exceeded", `${context} exceeds the token limit`, {
          lineIndex: this.lineIndex,
          offset: start,
        });
      }
    }
    if (this.index === start) {
      fail("token_expected", `${context} requires a token`, {
        lineIndex: this.lineIndex,
        offset: start,
      });
    }
    return this.line.slice(start, this.index);
  }

  private tryToken68(): { value: string; end: number; next: number } | null {
    const start = this.index;
    let cursor = start;
    while (cursor < this.line.length && TOKEN68_BASE_CHARACTERS.has(this.line[cursor]!)) {
      cursor += 1;
      if (cursor - start > this.limits.maxTokenCharacters) {
        fail("token_length_limit_exceeded", "token68 exceeds the token limit", {
          lineIndex: this.lineIndex,
          offset: start,
        });
      }
    }
    if (cursor === start) return null;
    while (cursor < this.line.length && this.line[cursor] === "=") cursor += 1;
    const tokenEnd = cursor;
    while (cursor < this.line.length && isOws(this.line[cursor])) cursor += 1;
    if (cursor !== this.line.length && this.line[cursor] !== ",") return null;
    return { value: this.line.slice(start, tokenEnd), end: tokenEnd, next: cursor };
  }

  private parseQuotedString(): { value: string; raw: string } {
    const start = this.index;
    this.index += 1;
    let value = "";
    while (this.index < this.line.length) {
      const character = this.line[this.index]!;
      const code = this.line.charCodeAt(this.index);
      if (character === "\"") {
        this.index += 1;
        return { value, raw: this.line.slice(start, this.index) };
      }
      if (character === "\\") {
        this.index += 1;
        if (this.index >= this.line.length) {
          fail("invalid_quoted_string", "quoted-pair is missing its following character", {
            lineIndex: this.lineIndex,
            offset: this.index - 1,
          });
        }
        const escaped = this.line[this.index]!;
        const escapedCode = this.line.charCodeAt(this.index);
        if (escapedCode > 0xff || escapedCode === 0x7f ||
            (escapedCode < 0x20 && escapedCode !== 0x09)) {
          fail("invalid_quoted_string", "quoted-pair contains an invalid character", {
            lineIndex: this.lineIndex,
            offset: this.index,
          });
        }
        value += escaped;
        this.index += 1;
        continue;
      }
      const qdtext = code === 0x09 || code === 0x20 || code === 0x21 ||
        (code >= 0x23 && code <= 0x5b) || (code >= 0x5d && code <= 0x7e) ||
        (code >= 0x80 && code <= 0xff);
      if (!qdtext) {
        fail("invalid_quoted_string", "quoted string contains an invalid character", {
          lineIndex: this.lineIndex,
          offset: this.index,
        });
      }
      value += character;
      this.index += 1;
    }
    return fail("invalid_quoted_string", "quoted string is not closed", {
      lineIndex: this.lineIndex,
      offset: start,
    });
  }

  private parseParameter(): AuthenticationParameter {
    const start = this.index;
    const name = this.parseToken("authentication parameter name");
    this.skipOws();
    if (this.line[this.index] !== "=") {
      fail("parameter_equals_required", "authentication parameter requires '='", {
        lineIndex: this.lineIndex,
        offset: this.index,
      });
    }
    this.index += 1;
    this.skipOws();
    const valueStart = this.index;
    const parsed = this.line[this.index] === "\""
      ? this.parseQuotedString()
      : (() => {
          const value = this.parseToken("authentication parameter value");
          return { value, raw: this.line.slice(valueStart, this.index) };
        })();
    if (parsed.raw.startsWith("\"") && this.index < this.line.length &&
        !isOws(this.line[this.index]) && this.line[this.index] !== ",") {
      fail("invalid_quoted_string", "quoted string must end before the next delimiter", {
        lineIndex: this.lineIndex,
        offset: this.index,
      });
    }
    return {
      name,
      normalizedName: name.toLowerCase(),
      value: parsed.value,
      rawValue: parsed.raw,
      raw: this.line.slice(start, this.index),
    };
  }

  private nextItemIsParameter(): boolean {
    const saved = this.index;
    if (!TOKEN_CHARACTERS.has(this.line[this.index]!)) return false;
    while (this.index < this.line.length && TOKEN_CHARACTERS.has(this.line[this.index]!)) {
      this.index += 1;
    }
    while (this.index < this.line.length && isOws(this.line[this.index])) this.index += 1;
    const result = this.line[this.index] === "=";
    this.index = saved;
    return result;
  }

  private parseChallenge(): AuthenticationChallenge {
    const start = this.index;
    const scheme = this.parseToken("authentication scheme");
    const challenge: AuthenticationChallenge = {
      scheme,
      normalizedScheme: scheme.toLowerCase(),
      token68: null,
      params: [],
      lineIndex: this.lineIndex,
      start,
      end: 0,
      raw: "",
    };
    if (this.index === this.line.length || this.line[this.index] === ",") {
      challenge.end = this.index;
      challenge.raw = this.line.slice(start, challenge.end);
      return challenge;
    }
    if (this.line[this.index] !== " ") {
      return fail("scheme_separator_invalid", "scheme credentials require at least one SP", {
        lineIndex: this.lineIndex,
        offset: this.index,
      });
    }
    while (this.line[this.index] === " ") this.index += 1;
    if (this.index === this.line.length || this.line[this.index] === ",") {
      return fail("credentials_expected", "scheme separator must be followed by credentials", {
        lineIndex: this.lineIndex,
        offset: this.index,
      });
    }
    const token68 = this.tryToken68();
    if (token68) {
      challenge.token68 = token68.value;
      this.index = token68.next;
      challenge.end = trimOwsEnd(this.line, start, token68.end);
      challenge.raw = this.line.slice(start, challenge.end);
      return challenge;
    }
    const names = new Set<string>();
    while (true) {
      if (challenge.params.length >= this.limits.maxParamsPerChallenge) {
        return fail("parameter_count_limit_exceeded", "challenge has too many parameters", {
          lineIndex: this.lineIndex,
          offset: this.index,
        });
      }
      const parameter = this.parseParameter();
      if (names.has(parameter.normalizedName)) {
        return fail("duplicate_parameter", "challenge repeats a parameter name", {
          lineIndex: this.lineIndex,
          offset: this.index,
          parameter: parameter.normalizedName,
        });
      }
      names.add(parameter.normalizedName);
      challenge.params.push(parameter);
      const parameterEnd = this.index;
      this.skipOws();
      if (this.index === this.line.length) {
        challenge.end = trimOwsEnd(this.line, start, parameterEnd);
        challenge.raw = this.line.slice(start, challenge.end);
        return challenge;
      }
      if (this.line[this.index] !== ",") {
        return fail("challenge_delimiter_expected", "challenge data must end or continue with a comma", {
          lineIndex: this.lineIndex,
          offset: this.index,
        });
      }
      const comma = this.index;
      this.index += 1;
      this.skipOws();
      if (this.index === this.line.length) {
        challenge.end = trimOwsEnd(this.line, start, comma);
        challenge.raw = this.line.slice(start, challenge.end);
        return challenge;
      }
      if (this.nextItemIsParameter()) continue;
      challenge.end = trimOwsEnd(this.line, start, comma);
      challenge.raw = this.line.slice(start, challenge.end);
      this.index = comma;
      return challenge;
    }
  }

  parse(): AuthenticationChallenge[] {
    while (true) {
      this.skipOws();
      while (this.line[this.index] === ",") {
        this.index += 1;
        this.skipOws();
      }
      if (this.index >= this.line.length) return this.challenges;
      this.challenges.push(this.parseChallenge());
      if (this.challenges.length > this.limits.maxChallenges) {
        return fail("challenge_count_limit_exceeded", "field line has too many challenges", {
          lineIndex: this.lineIndex,
          offset: this.index,
        });
      }
      this.skipOws();
      if (this.index >= this.line.length) return this.challenges;
      if (this.line[this.index] !== ",") {
        return fail("challenge_delimiter_expected", "challenge must be followed by a comma", {
          lineIndex: this.lineIndex,
          offset: this.index,
        });
      }
    }
  }
}

export function parseAuthenticationFields(
  headerLines: readonly string[],
  suppliedLimits: Partial<AuthenticationFieldLimits> = {},
): {
  aggregateBytes: number;
  fieldLineCount: number;
  challenges: AuthenticationChallenge[];
} {
  const limits = { ...RFC9110_AUTH_LIMITS, ...suppliedLimits };
  if (headerLines.length > limits.maxFieldLines) {
    fail("field_line_limit_exceeded", "too many authentication field lines", {
      actual: headerLines.length,
      maximum: limits.maxFieldLines,
    });
  }
  let aggregateBytes = 0;
  for (let index = 0; index < headerLines.length; index += 1) {
    const line = headerLines[index];
    if (typeof line !== "string") {
      fail("field_line_type_invalid", "authentication field lines must be strings");
    }
    validateFieldLine(line, index);
    aggregateBytes += Buffer.byteLength(line, "latin1");
  }
  if (aggregateBytes > limits.maxAggregateBytes) {
    fail("aggregate_byte_limit_exceeded", "authentication fields exceed the byte limit", {
      actual: aggregateBytes,
      maximum: limits.maxAggregateBytes,
    });
  }
  const challenges: AuthenticationChallenge[] = [];
  for (let index = 0; index < headerLines.length; index += 1) {
    challenges.push(...new LineParser(headerLines[index]!, index, limits).parse());
    if (challenges.length > limits.maxChallenges) {
      fail("challenge_count_limit_exceeded", "authentication fields have too many challenges", {
        actual: challenges.length,
        maximum: limits.maxChallenges,
      });
    }
  }
  return { aggregateBytes, fieldLineCount: headerLines.length, challenges };
}

export function authenticationParameterObject(
  challenge: AuthenticationChallenge,
): Record<string, string> {
  return Object.fromEntries(
    challenge.params.map((parameter) => [parameter.normalizedName, parameter.value]),
  );
}
