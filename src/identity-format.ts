import type {
  LinkedIdentityRepresentation,
  OperationActorSnapshot,
  PrincipalRepresentation,
} from "../sdk/dist/index.js";

function inline(value: string): string {
  return `\`${value}\``;
}

export function formatLinkedIdentity(identity: LinkedIdentityRepresentation): string {
  const lifecycle = identity.effective_status === "active"
    ? "active"
    : identity.effective_status;
  return `${inline(identity.identity_link_id)} ${identity.kind} ${inline(identity.display_subject || identity.public_subject)} — ${identity.proof_protocol} (${lifecycle}) — public attribution only, not organization authority`;
}

export function formatPrincipal(principal: PrincipalRepresentation | null | undefined): string {
  if (!principal) return "unresolved";
  const label = principal.display_name
    ? `${principal.display_name} (${inline(principal.principal_id)})`
    : inline(principal.principal_id);
  const links = principal.linked_identities.length > 0
    ? `; links: ${principal.linked_identities.map(formatLinkedIdentity).join(", ")}`
    : "; links: none";
  return `${label}, type ${principal.principal_type}${links}`;
}

export function formatActor(actor: OperationActorSnapshot | null | undefined): string {
  if (!actor) return "legacy / unavailable";
  const principal = actor.principal
    ? actor.principal.display_name_at_capture
      ? `${actor.principal.display_name_at_capture} (${inline(actor.principal.principal_id)})`
      : inline(actor.principal.principal_id)
    : "system";
  const links = actor.principal?.linked_identities_at_capture ?? [];
  const linked = links.length > 0
    ? links.map((link) => `${link.kind} ${inline(link.display_subject || link.public_subject)}`).join(", ")
    : "none";
  const authenticator = actor.authenticator
    ? `${actor.authenticator.kind} ${inline(actor.authenticator.public_subject)}`
    : "none";
  const authority = typeof actor.authority.kind === "string"
    ? actor.authority.kind
    : "unknown";
  return `${principal}; authenticator: ${authenticator}; links at action: ${linked}; authority: ${authority}`;
}
