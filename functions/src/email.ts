import { config } from "./config.js";

export interface EmailRawOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from_name?: string;
  template?: never;
  variables?: never;
}

export interface EmailTemplateOptions {
  to: string;
  template: string;
  variables?: Record<string, string>;
  from_name?: string;
  subject?: never;
  html?: never;
  text?: never;
}

export type EmailSendOptions = EmailRawOptions | EmailTemplateOptions;

export interface EmailSendResult {
  id: string;
  [key: string]: unknown;
}

export const email = (() => {
  let _mailboxId: string | null = null;

  async function _discoverMailbox(): Promise<string> {
    if (_mailboxId) return _mailboxId;
    const res = await fetch(config.API_BASE + "/mailboxes/v1", {
      headers: { Authorization: "Bearer " + config.SERVICE_KEY },
    });
    if (!res.ok) throw new Error("Failed to discover mailbox: " + (await res.text()));
    const data = (await res.json()) as { mailboxes: { mailbox_id: string }[] };
    if (!data.mailboxes || data.mailboxes.length === 0) {
      throw new Error("No mailbox configured for this project");
    }
    _mailboxId = data.mailboxes[0].mailbox_id;
    return _mailboxId;
  }

  return {
    async send(opts: EmailSendOptions): Promise<EmailSendResult> {
      const mbxId = await _discoverMailbox();
      const body: Record<string, unknown> = { to: opts.to };
      if ("template" in opts && opts.template) {
        body.template = opts.template;
        body.variables = opts.variables || {};
      } else {
        body.subject = (opts as EmailRawOptions).subject;
        body.html = (opts as EmailRawOptions).html;
        if ((opts as EmailRawOptions).text) body.text = (opts as EmailRawOptions).text;
      }
      if (opts.from_name) body.from_name = opts.from_name;
      const res = await fetch(config.API_BASE + "/mailboxes/v1/" + mbxId + "/messages", {
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
        throw new Error("Email send failed (" + res.status + "): " + msg);
      }
      return res.json() as Promise<EmailSendResult>;
    },
  };
})();
