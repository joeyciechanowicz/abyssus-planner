import { buildSchema, type Build } from '../model/build';

/**
 * Builds live in the URL hash so they can be shared without a server.
 *
 * Current format: `2.` + base64url(UTF-8 JSON). The version prefix lets the
 * format change later without breaking links already posted. Links from before
 * the prefix existed (plain base64 of URI-encoded JSON) still decode.
 */
const VERSION = '2.';

function toBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export function encodeBuild(build: Build): string {
  return VERSION + toBase64Url(JSON.stringify(build));
}

export function decodeBuild(hash: string): Build | null {
  const raw = hash.replace(/^#/, '');
  if (!raw) return null;
  try {
    const json = raw.startsWith(VERSION)
      ? fromBase64Url(raw.slice(VERSION.length))
      : decodeURIComponent(atob(raw)); // version 1
    const parsed = buildSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
