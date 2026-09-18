import { buildSchema, type Build } from '../model/build';

/** Builds live in the URL hash so they can be shared without a server. */
export function encodeBuild(build: Build): string {
  return btoa(encodeURIComponent(JSON.stringify(build)));
}

export function decodeBuild(hash: string): Build | null {
  const raw = hash.replace(/^#/, '');
  if (!raw) return null;
  try {
    const parsed = buildSchema.safeParse(JSON.parse(decodeURIComponent(atob(raw))));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
