/**
 * AES-GCM 加密 Cursor cookie jar。
 * 密文格式：base64(iv + ciphertext + tag)
 */

export interface CursorCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
}

const IV_LEN = 12;
const KEY_LEN = 32;

function getSubtle() {
  return crypto.subtle;
}

function normalizeKey(key: Uint8Array): ArrayBuffer {
  if (key.length !== KEY_LEN) {
    throw new Error(`Cursor crypto key must be ${KEY_LEN} bytes`);
  }
  return key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer;
}

export async function encryptCookieJar(
  rawCookies: CursorCookie[],
  key: Uint8Array,
): Promise<string> {
  const k = normalizeKey(key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const data = new TextEncoder().encode(JSON.stringify(rawCookies));
  const cryptoKey = await getSubtle().importKey("raw", k, "AES-GCM", false, ["encrypt"]);
  const encrypted = new Uint8Array(await getSubtle().encrypt({ name: "AES-GCM", iv }, cryptoKey, data));

  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv, 0);
  combined.set(encrypted, iv.length);
  return Buffer.from(combined).toString("base64");
}

export async function decryptCookieJar(
  encrypted: string,
  key: Uint8Array,
): Promise<CursorCookie[]> {
  const k = normalizeKey(key);
  const combined = Buffer.from(encrypted, "base64");
  if (combined.length < IV_LEN + 16) {
    throw new Error("Invalid encrypted cookie jar");
  }
  const iv = combined.subarray(0, IV_LEN);
  const cipher = combined.subarray(IV_LEN);

  const cryptoKey = await getSubtle().importKey("raw", k, "AES-GCM", false, ["decrypt"]);
  const decrypted = await getSubtle().decrypt({ name: "AES-GCM", iv }, cryptoKey, cipher);
  return JSON.parse(new TextDecoder().decode(decrypted)) as CursorCookie[];
}
