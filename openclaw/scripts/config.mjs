/**
 * Run402 config loader — re-exports from CLI's config module.
 * All shared logic lives in core/, CLI wraps with process.exit behavior.
 */

export {
  CONFIG_DIR, ALLOWANCE_FILE, PROJECTS_FILE, API,
  readAllowance, saveAllowance,
  allowanceAuthHeaders, findProject,
  loadKeyStore, saveProject, removeProject, saveKeyStore,
} from "../../cli/lib/config.mjs";
