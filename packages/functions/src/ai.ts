import { config } from "./config.js";

export interface TranslateOptions {
  from?: string;
  context?: string;
}

export interface TranslateResult {
  text: string;
  from: string;
  to: string;
  [key: string]: unknown;
}

export interface ModerateResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  [key: string]: unknown;
}

export const ai = {
  async translate(
    text: string,
    to: string,
    opts?: TranslateOptions,
  ): Promise<TranslateResult> {
    const body: Record<string, string> = { text, to };
    if (opts?.from) body.from = opts.from;
    if (opts?.context) body.context = opts.context;
    const res = await fetch(config.API_BASE + "/ai/v1/translate", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.SERVICE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text();
      let msg: string;
      try {
        msg = (JSON.parse(errBody) as { error?: string }).error || errBody;
      } catch {
        msg = errBody;
      }
      throw new Error("Translation failed (" + res.status + "): " + msg);
    }
    return res.json() as Promise<TranslateResult>;
  },

  async moderate(text: string): Promise<ModerateResult> {
    const res = await fetch(config.API_BASE + "/ai/v1/moderate", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.SERVICE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      let msg: string;
      try {
        msg = (JSON.parse(errBody) as { error?: string }).error || errBody;
      } catch {
        msg = errBody;
      }
      throw new Error("Moderation failed (" + res.status + "): " + msg);
    }
    return res.json() as Promise<ModerateResult>;
  },
};
