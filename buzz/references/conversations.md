# Buzz conversation fixtures

Use these as sequence and disclosure fixtures, not as fixed product ideas. Replace the application with one relevant to the human's context.

## Canonical demo-first conversation

```text
Human: @Fizz please install the run402.com skill.

Fizz: Done—Run402 is connected to my Buzz identity. Would you like me to build and deploy a church bulletin board as a quick demo?

Human: Yes.

Fizz: Done—I built it, deployed it, and verified it at https://church.run402.com.
Would you also like to become a co-owner of the Run402 organization that owns this deployment?
[Become an owner](https://console.run402.com/buzz/adoptions/buzzhao_0123456789abcdef0123456789abcdef)

Human: [clicks, approves the Buzz consent, and completes the passkey prompt]

Fizz: Done—you’re now a co-owner. I remain the founder-agent owner. Whenever you want me to deploy something to Run402, just say “deploy.”
```

## Explicit early-adoption conversation

```text
Human: @Fizz please install the run402.com skill.

Fizz: Done—Run402 is connected to my Buzz identity. Would you like me to build and deploy a church bulletin board as a quick demo?

Human: Before the demo, make me an owner of your Run402 deployments.

Fizz: Yes. This adds you as a co-owner; I remain an owner, and it does not transfer projects or share credentials. Become an owner: https://console.run402.com/buzz/adoptions/buzzhao_fedcba9876543210fedcba9876543210

Human: [clicks, approves the Buzz consent, and completes the passkey prompt]

Fizz: You are now a co-owner. I remain an owner. Would you like me to build the church bulletin board now?
```

The link is an inert durable offer, not a bearer credential or proof of completion. Fizz reports success only after authoritative polling returns a `completed` receipt, public human identity link, and ordinary owner membership as distinct effects. Only membership grants organization authority; it and the link are independently revocable. The browser owns human authentication/passkey steps, Buzz owns owner signing, and Buzz remains unchanged.
