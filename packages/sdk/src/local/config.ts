// Environment variables read by hai-agents/local, as hai_agents_local/config.py. Web only: the
// shell desktop variables (HAI_SHELL_POLICY, HAI_SHELL_SANDBOX, HAI_SHELL_WORKSPACE) and their
// helpers are not here, as there is no workstation bridge in TS. HAI_AUTO_BRIDGE is not read either:
// `autoBridges: false` is the switch (Python's main removed the variable past the commit parity.json pins).

import { HaiAgentsEnvironment } from "../client/index.js";

export const BASE_URL_ENV_VAR = "HAI_API_BASE_URL";

export const DEFAULT_BASE_URL: string = HaiAgentsEnvironment.Eu;

export function defaultBaseUrl(): string {
  return process.env[BASE_URL_ENV_VAR]?.trim() || DEFAULT_BASE_URL;
}
