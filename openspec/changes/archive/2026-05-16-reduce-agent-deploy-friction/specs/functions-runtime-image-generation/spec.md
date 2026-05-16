## ADDED Requirements

### Requirement: Functions Runtime Exposes Image Generation Helper

`@run402/functions` SHALL expose `ai.generateImage(options)` for use inside deployed serverless functions.

The helper SHALL accept an options object with `prompt: string` and optional `aspect: "square" | "landscape" | "portrait"`. The helper SHALL return `{ image: string, content_type: string, aspect: string }`, where `image` is base64-encoded PNG bytes or the gateway-documented image encoding.

The package entrypoint SHALL export the helper types, including `GenerateImageOptions`, `GenerateImageResult`, and the image aspect type.

#### Scenario: Function generates an image

- **WHEN** deployed function code imports `{ ai }` from `@run402/functions` and calls `ai.generateImage({ prompt: "a moonlit dream", aspect: "landscape" })`
- **THEN** the helper SHALL call the Run402 runtime image endpoint with the project service credentials
- **AND** it SHALL resolve to an object containing `image`, `content_type`, and `aspect`

#### Scenario: Invalid aspect is rejected before request when practical

- **WHEN** function code calls `ai.generateImage({ prompt: "x", aspect: "panorama" as never })`
- **THEN** the helper SHALL reject with an error that identifies the supported aspects
- **AND** it SHALL NOT send a malformed image-generation request when validation can happen locally

### Requirement: Runtime Image Generation Uses Project Billing Authority

Image generation from inside deployed functions SHALL be billed and limited against project runtime authority, not against an agent's local allowance wallet.

The runtime helper SHALL NOT require wallet private keys, allowance files, x402 wrapping, or manual signing inside the deployed function environment. The gateway SHALL enforce per-project rate limits and spend caps before generating images. Errors for quota or spend-cap exhaustion SHALL be ordinary runtime API errors suitable for app handling and SHALL NOT expose a raw owner x402 payment challenge to the browser by default.

#### Scenario: No allowance wallet is needed inside function

- **WHEN** a deployed function uses `ai.generateImage`
- **THEN** the function environment SHALL NOT need `RUN402_ALLOWANCE_PATH`, wallet keys, or x402 payment code
- **AND** billing SHALL use project-owned runtime limits enforced by the gateway

#### Scenario: Spend cap blocks generation

- **WHEN** the project has exhausted its image-generation runtime cap
- **THEN** `ai.generateImage` SHALL reject with an error containing a stable code or message suitable for application handling
- **AND** the function author SHALL NOT need to parse an x402 payment challenge

### Requirement: Runtime Image Generation Is Documented For Full-Stack Apps

Agent-facing docs for `@run402/functions` SHALL show `ai.generateImage` alongside `ai.translate` and `ai.moderate`.

The docs SHALL include a routed-function example where user input produces an image at request time. The docs SHALL mention billing ownership, supported aspect ratios, result shape, and recommended app-level authorization or rate limiting for public routes.

#### Scenario: Agent learns live app image flow

- **WHEN** an agent reads functions runtime docs for building a user-generated-content app
- **THEN** it SHALL see that images can be generated from a deployed function at request time
- **AND** it SHALL not be directed to pre-generate all images at deploy time

