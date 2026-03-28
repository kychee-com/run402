## MODIFIED Requirements

### Requirement: Daily send rate limit
The system SHALL enforce a daily send limit per mailbox based on the project's tier: prototype=10, hobby=50, team=500. The counter resets at midnight UTC.

#### Scenario: Daily limit reached
- **WHEN** a prototype-tier mailbox has sent 10 emails today and the agent sends another
- **THEN** the system SHALL return 429 with `{"error": "Daily send limit reached", "limit": 10, "resets_at": "2026-03-25T00:00:00Z"}`

#### Scenario: Team tier daily limit
- **WHEN** a team-tier mailbox has sent 500 emails today and the agent sends another
- **THEN** the system SHALL return 429 with `{"error": "Daily send limit reached", "limit": 500, "resets_at": "..."}`
