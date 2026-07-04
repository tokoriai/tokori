/**
 * Baidu Fanyi — `appid` + `secret` auth with an MD5-signed request.
 *
 * Baidu requires `sign = md5(appid + q + salt + secret)`, where `q` is the
 * (joined) text. We send one POST per call, joining batched words with
 * Baidu's documented `\n` separator. WebCrypto doesn't expose MD5 so the
 * signing helper at the bottom is a small standalone implementation.
 *
 * Source language tip: Baidu uses `zh` for Chinese, `jp` for Japanese,
 * `kor` for Korean. The engine maps the obvious BCP-47 codes; anything
 * else is forwarded as-is.
 */

import { Cloud } from "lucide-react";
import type { TranslateEngine, TranslateRequest } from "../api";

const ENDPOINT = "https://fanyi-api.baidu.com/api/trans/vip/translate";

const BAIDU_LANG: Record<string, string> = {
  zh: "zh",
  en: "en",
  ja: "jp",
  ko: "kor",
  fr: "fra",
  es: "spa",
  de: "de",
  ru: "ru",
  it: "it",
  pt: "pt",
  ar: "ara",
  th: "th",
  vi: "vie",
};

function mapLang(code: string): string {
  return BAIDU_LANG[code.toLowerCase()] ?? code.toLowerCase();
}

type BaiduResponse = {
  trans_result?: { src: string; dst: string }[];
  error_code?: string;
  error_msg?: string;
};

const engine: TranslateEngine = {
  meta: {
    kind: "baidu",
    name: "Baidu Fanyi",
    description:
      "Baidu Translate. Use the App ID as API key and the secret as Secondary key (from fanyi-api.baidu.com).",
    fields: ["apiKey", "secondaryKey"],
    icon: Cloud,
  },
  async translate({ texts, source, target, config }: TranslateRequest) {
    const appid = config.apiKey?.trim();
    const secret = config.secondaryKey?.trim();
    if (!appid || !secret) {
      throw new Error("Baidu requires both App ID and Secret.");
    }
    const q = texts.join("\n");
    const salt = String(Date.now());
    const sign = await md5(appid + q + salt + secret);
    const params = new URLSearchParams({
      q,
      from: mapLang(source),
      to: mapLang(target),
      appid,
      salt,
      sign,
    });
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const json = (await res.json()) as BaiduResponse;
    if (json.error_code) {
      throw new Error(`baidu ${json.error_code}: ${json.error_msg ?? ""}`);
    }
    const results = json.trans_result ?? [];
    // Baidu returns rows in input order — index by position.
    return texts.map((_, i) => results[i]?.dst ?? "");
  },
};

export default engine;

// ─── MD5 ──────────────────────────────────────────────────────────────────
//
// SubtleCrypto doesn't ship MD5 (deprecated for crypto), but Baidu Fanyi
// still requires it for request signing. The implementation below is a
// compact public-domain MD5 (RFC 1321) — small enough to inline rather
// than pull a 200-line npm dep for one engine.

async function md5(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  return md5Bytes(bytes);
}

function md5Bytes(bytes: Uint8Array): string {
  // Length in bits, mod 2^64.
  const lenBits = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 8) >> 6 << 6) + 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  // Little-endian 64-bit length at the end.
  const lenLo = lenBits >>> 0;
  const lenHi = Math.floor(lenBits / 0x100000000) >>> 0;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, lenLo, true);
  dv.setUint32(padded.length - 4, lenHi, true);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  const T = MD5_T;
  const S = MD5_S;
  const X = new Uint32Array(16);

  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j++) X[j] = dv.getUint32(i + j * 4, true);
    let aa = a, bb = b, cc = c, dd = d;
    for (let j = 0; j < 64; j++) {
      let f = 0, g = 0;
      if (j < 16) { f = (bb & cc) | (~bb & dd); g = j; }
      else if (j < 32) { f = (dd & bb) | (~dd & cc); g = (5 * j + 1) % 16; }
      else if (j < 48) { f = bb ^ cc ^ dd; g = (3 * j + 5) % 16; }
      else { f = cc ^ (bb | ~dd); g = (7 * j) % 16; }
      const temp = (dd >>> 0);
      dd = cc;
      cc = bb;
      const sum = (aa + (f >>> 0) + T[j] + X[g]) >>> 0;
      bb = (bb + ((sum << S[j]) | (sum >>> (32 - S[j])))) >>> 0;
      aa = temp;
    }
    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }

  return [a, b, c, d].map(toHexLE).join("");
}

function toHexLE(n: number): string {
  const bytes = [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

const MD5_S = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

const MD5_T = new Uint32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
  0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);
