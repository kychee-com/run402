export type ProjectOperationPlane = "control" | "data" | "local";
export type ProjectOperationAuthMode =
  | "principal"
  | "delegate"
  | "service_key"
  | "project_credential"
  | "anon_key";

export interface ProjectOperationAuthClassification {
  operation: string;
  scope: "project";
  plane: ProjectOperationPlane;
  authModes: ProjectOperationAuthMode[];
  defaultAuthMode: ProjectOperationAuthMode;
  requiresProjectId: boolean;
  mayUseLocalCredentialCache: boolean;
  localCredentialMissCode?: "PROJECT_CREDENTIAL_NOT_FOUND";
}

export const PROJECT_OPERATION_AUTH_CLASSIFICATIONS = [
  {
    operation: "projects.list",
    scope: "project",
    plane: "control",
    authModes: ["principal", "delegate"],
    defaultAuthMode: "principal",
    requiresProjectId: false,
    mayUseLocalCredentialCache: false,
  },
  {
    operation: "projects.get",
    scope: "project",
    plane: "control",
    authModes: ["principal", "delegate"],
    defaultAuthMode: "principal",
    requiresProjectId: true,
    mayUseLocalCredentialCache: false,
  },
  {
    operation: "projects.use",
    scope: "project",
    plane: "control",
    authModes: ["principal", "delegate"],
    defaultAuthMode: "principal",
    requiresProjectId: true,
    mayUseLocalCredentialCache: false,
  },
  {
    operation: "projects.keys",
    scope: "project",
    plane: "local",
    authModes: ["project_credential"],
    defaultAuthMode: "project_credential",
    requiresProjectId: true,
    mayUseLocalCredentialCache: true,
    localCredentialMissCode: "PROJECT_CREDENTIAL_NOT_FOUND",
  },
  {
    operation: "projects.sql",
    scope: "project",
    plane: "data",
    authModes: ["service_key"],
    defaultAuthMode: "project_credential",
    requiresProjectId: true,
    mayUseLocalCredentialCache: true,
    localCredentialMissCode: "PROJECT_CREDENTIAL_NOT_FOUND",
  },
  {
    operation: "projects.rest",
    scope: "project",
    plane: "data",
    authModes: ["anon_key", "service_key"],
    defaultAuthMode: "project_credential",
    requiresProjectId: true,
    mayUseLocalCredentialCache: true,
    localCredentialMissCode: "PROJECT_CREDENTIAL_NOT_FOUND",
  },
  {
    operation: "domains.add",
    scope: "project",
    plane: "control",
    authModes: ["principal", "delegate", "service_key"],
    defaultAuthMode: "principal",
    requiresProjectId: true,
    mayUseLocalCredentialCache: false,
  },
  {
    operation: "domains.list",
    scope: "project",
    plane: "control",
    authModes: ["principal", "delegate", "service_key"],
    defaultAuthMode: "principal",
    requiresProjectId: true,
    mayUseLocalCredentialCache: false,
  },
  {
    operation: "domains.status",
    scope: "project",
    plane: "control",
    authModes: ["principal", "delegate", "service_key"],
    defaultAuthMode: "principal",
    requiresProjectId: true,
    mayUseLocalCredentialCache: false,
  },
  {
    operation: "domains.delete",
    scope: "project",
    plane: "control",
    authModes: ["principal", "delegate", "service_key"],
    defaultAuthMode: "principal",
    requiresProjectId: true,
    mayUseLocalCredentialCache: false,
  },
  {
    operation: "functions.*",
    scope: "project",
    plane: "control",
    authModes: ["service_key"],
    defaultAuthMode: "project_credential",
    requiresProjectId: true,
    mayUseLocalCredentialCache: true,
    localCredentialMissCode: "PROJECT_CREDENTIAL_NOT_FOUND",
  },
  {
    operation: "assets.*",
    scope: "project",
    plane: "data",
    authModes: ["service_key"],
    defaultAuthMode: "project_credential",
    requiresProjectId: true,
    mayUseLocalCredentialCache: true,
    localCredentialMissCode: "PROJECT_CREDENTIAL_NOT_FOUND",
  },
  {
    operation: "jobs.*",
    scope: "project",
    plane: "control",
    authModes: ["service_key"],
    defaultAuthMode: "project_credential",
    requiresProjectId: true,
    mayUseLocalCredentialCache: true,
    localCredentialMissCode: "PROJECT_CREDENTIAL_NOT_FOUND",
  },
] as const satisfies readonly ProjectOperationAuthClassification[];

export function projectOperationAuthClassification(operation: string): ProjectOperationAuthClassification | null {
  return PROJECT_OPERATION_AUTH_CLASSIFICATIONS.find((entry) => {
    if (entry.operation === operation) return true;
    if (entry.operation.endsWith(".*")) return operation.startsWith(entry.operation.slice(0, -1));
    return false;
  }) ?? null;
}
