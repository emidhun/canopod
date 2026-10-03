// The app was called Canopy before it was Canopod, and its localStorage keys
// carried the old prefix (appearance, agent-lane layout, per-worktree task
// context). Copy each one to the new prefix once, without overwriting anything
// already written under the new name. Imported first by every entry point so it
// runs before any module reads storage.
const LEGACY = "canopy.";
const CURRENT = "canopod.";

export function migrateLegacyStorage(storage: Storage = localStorage): void {
  try {
    const legacy: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(LEGACY)) legacy.push(key);
    }
    for (const key of legacy) {
      const next = CURRENT + key.slice(LEGACY.length);
      const value = storage.getItem(key);
      if (value !== null && storage.getItem(next) === null) storage.setItem(next, value);
      storage.removeItem(key);
    }
  } catch {
    /* storage unavailable — nothing to carry over */
  }
}

migrateLegacyStorage();
