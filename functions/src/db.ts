import { config } from "./config.js";

interface QueryBuilderOpts {
  apikey: string;
  authorization: string | undefined;
  basePath: string;
}

export class QueryBuilder {
  #table: string;
  #params = new URLSearchParams();
  #method = "GET";
  #body: unknown = undefined;
  #apikey: string;
  #authorization: string | undefined;
  #basePath: string;

  constructor(table: string, opts: QueryBuilderOpts) {
    this.#table = table;
    this.#apikey = opts.apikey;
    this.#authorization = opts.authorization;
    this.#basePath = opts.basePath;
  }

  select(columns = "*"): this {
    this.#params.set("select", columns);
    return this;
  }

  eq(column: string, value: string | number): this {
    this.#params.append(column, `eq.${value}`);
    return this;
  }

  neq(column: string, value: string | number): this {
    this.#params.append(column, `neq.${value}`);
    return this;
  }

  gt(column: string, value: string | number): this {
    this.#params.append(column, `gt.${value}`);
    return this;
  }

  lt(column: string, value: string | number): this {
    this.#params.append(column, `lt.${value}`);
    return this;
  }

  gte(column: string, value: string | number): this {
    this.#params.append(column, `gte.${value}`);
    return this;
  }

  lte(column: string, value: string | number): this {
    this.#params.append(column, `lte.${value}`);
    return this;
  }

  like(column: string, pattern: string): this {
    this.#params.append(column, `like.${pattern}`);
    return this;
  }

  ilike(column: string, pattern: string): this {
    this.#params.append(column, `ilike.${pattern}`);
    return this;
  }

  in(column: string, values: (string | number)[]): this {
    this.#params.append(column, `in.(${values.join(",")})`);
    return this;
  }

  order(column: string, { ascending = true } = {}): this {
    this.#params.append("order", `${column}.${ascending ? "asc" : "desc"}`);
    return this;
  }

  limit(count: number): this {
    this.#params.set("limit", String(count));
    return this;
  }

  offset(count: number): this {
    this.#params.set("offset", String(count));
    return this;
  }

  insert(data: Record<string, unknown> | Record<string, unknown>[]): this {
    this.#method = "POST";
    this.#body = Array.isArray(data) ? data : [data];
    return this;
  }

  update(data: Record<string, unknown>): this {
    this.#method = "PATCH";
    this.#body = data;
    return this;
  }

  delete(): this {
    this.#method = "DELETE";
    return this;
  }

  then(
    resolve: (value: Record<string, unknown>[]) => void,
    reject: (reason: Error) => void,
  ): void {
    const qs = this.#params.toString();
    const url = `${config.API_BASE}${this.#basePath}/${this.#table}${qs ? "?" + qs : ""}`;

    const headers: Record<string, string> = {
      apikey: this.#apikey,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (this.#authorization) {
      headers.Authorization = this.#authorization;
    }

    fetch(url, {
      method: this.#method,
      headers,
      body: this.#body ? JSON.stringify(this.#body) : undefined,
    })
      .then(async (res) => {
        if (!res.ok) {
          const errBody = await res.text();
          reject(new Error(`PostgREST error (${res.status}): ${errBody}`));
          return;
        }
        const data = await res.json();
        resolve(data as Record<string, unknown>[]);
      })
      .catch(reject);
  }
}

function extractAuth(req: Request): string | undefined {
  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization");
  return auth ?? undefined;
}

interface CallerDbClient {
  from(table: string): QueryBuilder;
}

/**
 * Caller-context DB client. Forwards the incoming Request's Authorization
 * header to PostgREST so RLS policies evaluate against the caller's role.
 * `apikey` is the project's anon key (routing only — does not grant bypass).
 *
 * If the incoming Request has no Authorization, the request is sent with
 * just the anon apikey; PostgREST resolves role=anon and RLS decides whether
 * the query succeeds or returns 401/403.
 */
export function db(req: Request): CallerDbClient {
  if (!config.ANON_KEY) {
    throw new Error(
      "db(req) requires RUN402_ANON_KEY in the Lambda environment. " +
        "Redeploy this function via the gateway to pick up the new env var.",
    );
  }
  const authorization = extractAuth(req);
  const anonKey = config.ANON_KEY;
  return {
    from(table: string) {
      return new QueryBuilder(table, {
        apikey: anonKey,
        authorization,
        basePath: "/rest/v1",
      });
    },
  };
}

interface AdminDbClient {
  from(table: string): QueryBuilder;
  sql(query: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

/**
 * Admin DB client. Uses the project's service_key (role=service_role,
 * BYPASSRLS). Routes through /admin/v1/rest/* at the gateway, which rejects
 * any other caller than service_role. Use for explicit server-side operations
 * that must ignore RLS.
 *
 * `adminDb().sql()` targets the /projects/v1/admin/:id/sql endpoint, which
 * runs arbitrary SQL as a superuser-scoped role on the project schema.
 */
export function adminDb(): AdminDbClient {
  if (!config.SERVICE_KEY) {
    throw new Error("adminDb() requires RUN402_SERVICE_KEY in the Lambda environment.");
  }
  const serviceKey = config.SERVICE_KEY;
  return {
    from(table: string) {
      return new QueryBuilder(table, {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        basePath: "/admin/v1/rest",
      });
    },
    async sql(query: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
      const url = `${config.API_BASE}/projects/v1/admin/${config.PROJECT_ID}/sql`;
      const hasParams = Array.isArray(params) && params.length > 0;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": hasParams ? "application/json" : "text/plain",
        },
        body: hasParams ? JSON.stringify({ sql: query, params }) : query,
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`SQL error (${res.status}): ${errBody}`);
      }
      return res.json() as Promise<Record<string, unknown>[]>;
    },
  };
}
