import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { getApplicationDirectory, getDataDirectory, getWorkspaceId } from './server-storage.mjs';

export const RUNTIME_PRODUCT = 'memoryui';
export function validateBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
      typeof binding.dataDirectory !== 'string' || !path.isAbsolute(binding.dataDirectory) ||
      typeof binding.workspaceId !== 'string' || !/^[0-9a-f]{16}$/i.test(binding.workspaceId) ||
      !Number.isSafeInteger(binding.servicePort) || binding.servicePort < 1024 || binding.servicePort > 65535) throw new Error('Invalid MemoryUI vault binding');
  return { dataDirectory: path.resolve(binding.dataDirectory), workspaceId: binding.workspaceId.toLowerCase(), servicePort: binding.servicePort };
}

export function defaultVaultBinding(env = process.env) {
  const dataDirectory = path.join(getApplicationDirectory(env), 'default-vault');
  return { dataDirectory, workspaceId: getWorkspaceId(dataDirectory), servicePort: 4173 };
}

export function localBindingFile(env = process.env) {
  return path.join(getApplicationDirectory(env), 'local-binding.json');
}

export function readLocalBinding(env = process.env) {
  const filename = localBindingFile(env);
  if (!existsSync(filename)) return null;
  if (!statSync(filename).isFile() || statSync(filename).size > 16_384) throw new Error('Invalid MemoryUI local binding file');
  const input = JSON.parse(readFileSync(filename, 'utf8'));
  if (input.product !== RUNTIME_PRODUCT || input.schemaVersion !== 1) throw new Error('Invalid MemoryUI local binding file');
  return validateBinding(input);
}

// A distributable contains no machine paths. Resolve its stable vault locally;
// an upgraded installation may register its original vault without copying data.
export function resolveRuntimeConfig(config, skillRoot, env = process.env) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid MemoryUI runtime');
  const clientId = config.clientId ?? 'codex';
  if (!['codex', 'claude-code', 'workbuddy', 'chatgpt'].includes(clientId)) throw new Error('Invalid MemoryUI client');
  if (config.requireSimulation !== undefined && typeof config.requireSimulation !== 'boolean') throw new Error('Invalid MemoryUI mode');
  const requireSimulation = config.requireSimulation === true;
  let runtimeRoot;
  let binding;
  if (config.product === RUNTIME_PRODUCT && config.schemaVersion === 2) {
    if (config.runtimeRoot !== '.runtime') throw new Error('Invalid MemoryUI runtime location');
    runtimeRoot = path.join(skillRoot, '.runtime');
    if (config.binding === 'local') {
      if (requireSimulation) throw new Error('Simulation cannot use a live local binding');
      binding = readLocalBinding(env) || defaultVaultBinding(env);
    } else binding = validateBinding(config);
  } else {
    if (typeof config.workspaceRoot !== 'string' || !path.isAbsolute(config.workspaceRoot)) throw new Error('Invalid legacy MemoryUI runtime');
    runtimeRoot = path.resolve(config.workspaceRoot);
    binding = {
      workspaceId: getWorkspaceId(runtimeRoot), dataDirectory: getDataDirectory(runtimeRoot, env),
      servicePort: config.servicePort ?? (env.PORT === undefined ? 4173 : Number(env.PORT)),
    };
    validateBinding(binding);
  }
  if (requireSimulation && config.servicePort === undefined) throw new Error('Simulation must have a bound port');
  return { runtimeRoot, clientId, requireSimulation, ...binding };
}

export function resolveRuntimeBinding(config, { directory, env = process.env }) {
  const resolved = resolveRuntimeConfig(config, directory, env);
  return {
    root: resolved.runtimeRoot, client: resolved.clientId,
    env: {
      ...env, PORT: String(resolved.servicePort), MEMORYUI_WORKSPACE_ID: resolved.workspaceId,
      MEMORYUI_DATA_DIR: resolved.dataDirectory, MEMORYUI_REQUIRE_SIMULATION: resolved.requireSimulation ? '1' : '0',
      MEMORYUI_AUTO_START: resolved.requireSimulation ? '0' : '1',
    },
  };
}
