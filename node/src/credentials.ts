/** API-key handling for the agent process, without writing credentials to disk. */

import type { CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";

export const KEY_ENV = "HIVE_AGENT_API_KEY";

type CredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;
type Credential = Awaited<ReturnType<CredentialStore["read"]>>;

/** Read the key once and delete it, so the agent's own shell commands never inherit it. */
export function takeApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const key = env[KEY_ENV];
  Reflect.deleteProperty(env, KEY_ENV);
  return key === "" ? undefined : key;
}

/** A credential store that never touches disk, so Pi neither reads nor creates `auth.json`. */
export function memoryStore(): CredentialStore {
  const data = new Map<string, NonNullable<Credential>>();
  return {
    read: (id) => Promise.resolve(data.get(id)),
    list: () =>
      Promise.resolve(
        [...data].map(([providerId, c]) => ({ providerId, type: c.type })),
      ),
    modify: async (id, fn) => {
      const next = await fn(data.get(id));
      if (next) {
        data.set(id, next);
      }
      return data.get(id);
    },
    delete: (id) => {
      data.delete(id);
      return Promise.resolve();
    },
  };
}
