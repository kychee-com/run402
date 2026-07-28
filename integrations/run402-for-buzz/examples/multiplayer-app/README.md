# Multiplayer feedback app

This deliberately ordinary application makes the identity and deployment chain—not the application gimmick—the demo. It includes a public board, hosted sign-in for all mutations, Postgres-backed feedback/votes/comments, HTTPS attachment references, and an `admin`-role status action.

The attachment field is a scoped substitute for an in-app uploader: upload through run402 Assets, then store the returned HTTPS asset URL. The function never receives a storage credential.

## Deploy twice

From this directory, while using the repository-local run402 skill:

```sh
npm install
npm test
run402 identity link list --json
run402 projects provision --tier prototype --name buzz-feedback
run402 up --manifest run402.deploy.ts --plan --json
run402 up --manifest run402.deploy.ts --require-plan <plan_id> --plan-fingerprint <plan_fingerprint> --verify --json
```

Verify `GET /`, `GET /api/feedback`, authenticated create/vote/comment, and the admin status action independently. Commit a visible UI change, plan and apply again to the same linked project, then post the second receipt. Before production adoption, use the transfer preview and move root ownership to the company organization; retain only a scoped grant or delegate for the agent.

Never place a Buzz/Nostr private key, wallet private key, session, service key, or signed event in this directory.
