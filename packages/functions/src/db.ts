import { config } from "./config.js";

export class QueryBuilder {
  #table: string;
  #params = new URLSearchParams();
  #method = "GET";
  #body: unknown = undefined;

  constructor(table: string) {
    this.#table = table;
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
    const url = `${config.API_BASE}/rest/v1/${this.#table}${qs ? "?" + qs : ""}`;

    const headers: Record<string, string> = {
      apikey: config.SERVICE_KEY,
      Authorization: `Bearer ${config.SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };

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

export const db = {
  from(table: string): QueryBuilder {
    return new QueryBuilder(table);
  },

  async sql(query: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    const url = `${config.API_BASE}/projects/v1/admin/${config.PROJECT_ID}/sql`;
    const hasParams = Array.isArray(params) && params.length > 0;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.SERVICE_KEY}`,
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
