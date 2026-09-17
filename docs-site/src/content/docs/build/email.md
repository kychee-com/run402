---
title: Email
description: Configure a mailbox and send through explicit project authority.
---

Email belongs to a project and its configured mailbox/defaults. Follow the [email command reference](/cli/assets/) for mailbox creation, defaults and send options; inspect the chosen sender and destination before sending.

```bash
run402 email create app-mail --project prj_example
run402 email mailboxes --project prj_example
run402 email defaults --outbound app-mail --project prj_example
run402 email info --project prj_example
run402 email list --project prj_example --limit 20
```

A successful queued/accepted response is not proof that the recipient received a message. Retain returned identifiers and inspect delivery status through the supported workflow. Domain verification and sender restrictions are part of setup; do not describe an unverified address as ready.

For app-triggered transactional mail, use the server-side `email.send` helper in [the function reference](/cli/functions/). Protect the app endpoint and bound recipients/rate; never expose mailbox authority or provider credentials in a browser. Deploy the application with `run402 up` after its mailbox and required runtime configuration are ready.

For an authorized message to a real intended recipient, use `run402 email send --to <address> --subject <subject> --html <html> --project <project_id>`. The recipient placeholders are not test destinations. Inspect a returned message with `run402 email get <message_id> --project <project_id>`; mailbox visibility and delivery evidence are distinct.

## Read the result and recover

After creation, confirm the mailbox appears in `email mailboxes` and that `email info` reports the intended defaults. A missing outbound default is setup work; a provider or domain-verification failure needs the returned configuration action. Do not resend an accepted message just because delivery is still pending. Inspect its actual message ID first and follow the documented retry/idempotency contract.
