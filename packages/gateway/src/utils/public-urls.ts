const LOCALHOST_ROOT = "run402.com.localhost";
const PROD_ROOT = "run402.com";
const DEFAULT_PORT = "4022";

export function useLocalhostPublicUrls(): boolean {
  return process.env.RUN402_LOCALHOST_PUBLIC_URLS === "1";
}

function localPort(): string {
  return process.env.PORT || DEFAULT_PORT;
}

export function deploymentDnsLabel(deploymentId: string): string {
  return deploymentId.replace(/_/g, "-");
}

export function getDeploymentUrl(deploymentId: string): string {
  const dnsLabel = deploymentDnsLabel(deploymentId);
  if (useLocalhostPublicUrls()) {
    return `http://${dnsLabel}.sites.${LOCALHOST_ROOT}:${localPort()}`;
  }
  return `https://${dnsLabel}.sites.${PROD_ROOT}`;
}

export function getSubdomainUrl(name: string): string {
  if (useLocalhostPublicUrls()) {
    return `http://${name}.${LOCALHOST_ROOT}:${localPort()}`;
  }
  return `https://${name}.${PROD_ROOT}`;
}

export function parseDeploymentHost(host: string): string | null {
  const normalized = host.toLowerCase();
  const prodSuffix = `.sites.${PROD_ROOT}`;
  const localSuffix = `.sites.${LOCALHOST_ROOT}`;
  const suffix = normalized.endsWith(localSuffix)
    ? localSuffix
    : (normalized.endsWith(prodSuffix) ? prodSuffix : null);

  if (!suffix) return null;
  const label = normalized.slice(0, -suffix.length);
  if (!label || label.includes(".")) return null;
  return label.replace(/-/g, "_");
}

export function parseManagedSubdomain(host: string): string | null {
  const normalized = host.toLowerCase();
  const prodSuffix = `.${PROD_ROOT}`;
  const localSuffix = `.${LOCALHOST_ROOT}`;
  const suffix = normalized.endsWith(localSuffix)
    ? localSuffix
    : (normalized.endsWith(prodSuffix) ? prodSuffix : null);

  if (!suffix) return null;
  const subdomain = normalized.slice(0, -suffix.length);
  if (!subdomain || subdomain.includes(".")) return null;
  return subdomain;
}
