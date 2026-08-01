# Buzz conversation fixtures

Use these as sequence and disclosure fixtures, not as fixed product ideas. Replace the application with one relevant to the human's context.

## Canonical demo-first conversation

```text
Tal: Please install the run402.com skill.

Fizz: Installed from run402.com into my Buzz workspace. The skill is inert; I have not set up an identity, organization, project, or deployment. Would you like me to set up Run402?

Tal: Yes.

Fizz: Run402 is connected to my Buzz identity. I haven't deployed anything yet. I can build and deploy a small church bulletin board with posts and event RSVPs. Would you like me to try it?

Tal: Yes.

Fizz: Done — the church bulletin board is live at https://church.run402.com. Would you like to become a co-owner of the Run402 organization that owns this deployment? Become an owner: https://console.run402.com/buzz/adoptions/buzzhao_0123456789abcdef0123456789abcdef

Tal: [opens the link, signs in with a passkey, enters the displayed six-digit code in Buzz, and approves]

Fizz: You are now a co-owner of the Run402 organization behind the church bulletin board. I remain an owner, and no credentials, projects, or ownership were transferred. Whenever you want me to deploy something to Run402, just say “deploy.”
```

## Explicit early-adoption conversation

```text
Tal: Please install the run402.com skill.

Fizz: Installed from run402.com into my Buzz workspace. The skill is inert; I have not set up an identity, organization, project, or deployment. Would you like me to set up Run402?

Tal: Yes.

Fizz: Run402 is connected to my Buzz identity. I haven't deployed anything yet. I can build and deploy a small church bulletin board with posts and event RSVPs. Would you like me to try it?

Tal: Before the demo, make me an owner of your Run402 deployments.

Fizz: Yes. This adds you as a co-owner; I remain an owner, and it does not transfer projects or share credentials. Become an owner: https://console.run402.com/buzz/adoptions/buzzhao_fedcba9876543210fedcba9876543210

Tal: [opens the link, signs in with a passkey, enters the displayed six-digit code in Buzz, and approves]

Fizz: You are now a co-owner. I remain an owner. Would you like me to build the church bulletin board now?
```

The link is an inert durable offer, not a bearer credential or proof of completion. Fizz reports success only after authoritative polling returns `completed` with an active adoption. The browser owns human authentication and passkey steps; Buzz owns owner signing; no human command-line step or Buzz change appears in either conversation.
