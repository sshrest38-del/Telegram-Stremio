import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { base62Decode, decodeFilePayload, selectBotToken } from "../src/telegram";

const BASE62_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function base62Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (let i = 0; i < bytes.length; i++) {
    num = (num << 8n) | BigInt(bytes[i]);
  }
  const chars: string[] = [];
  while (num > 0n) {
    const rem = Number(num % 62n);
    num = num / 62n;
    chars.push(BASE62_ALPHABET[rem]);
  }
  return chars.reverse().join("") || "0";
}

function pythonEncodePayload(data: unknown): string {
  const jsonStr = JSON.stringify(data);
  const compressed = deflateSync(Buffer.from(jsonStr), { level: 9 });
  return base62Encode(new Uint8Array(compressed));
}

describe("telegram.ts — Payload Decoder & Token Rotation", () => {
  it("encodes and decodes base62 strings matching Python big-endian representation", () => {
    const testBytes = new Uint8Array([1, 2, 3, 4, 5, 255]);
    const encoded = base62Encode(testBytes);
    const decoded = base62Decode(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(testBytes));
  });

  it("decodes a single file payload { chat_id, msg_id }", () => {
    const original = { chat_id: 1234567890, msg_id: 42 };
    const encoded = pythonEncodePayload(original);

    const decoded = decodeFilePayload(encoded);
    expect(decoded.chat_id).toBe(1234567890);
    expect(decoded.msg_id).toBe(42);
  });

  it("decodes a multi-part split file payload { parts: [...] }", () => {
    const original = {
      parts: [
        { chat_id: 1001, msg_id: 10 },
        { chat_id: 1001, msg_id: 11 },
        { chat_id: 1001, msg_id: 12 },
      ],
    };
    const encoded = pythonEncodePayload(original);

    const decoded = decodeFilePayload(encoded);
    expect(decoded.parts).toHaveLength(3);
    expect(decoded.parts?.[0].msg_id).toBe(10);
    expect(decoded.parts?.[2].msg_id).toBe(12);
  });

  it("decodes a split ZIP archive payload { parts: [...], zip: true }", () => {
    const original = {
      parts: [
        { chat_id: 1001, msg_id: 20 },
        { chat_id: 1001, msg_id: 21 },
      ],
      zip: true,
    };
    const encoded = pythonEncodePayload(original);

    const decoded = decodeFilePayload(encoded);
    expect(decoded.parts).toHaveLength(2);
    expect(decoded.zip).toBe(true);
  });

  it("rotates bot tokens in round-robin fashion", () => {
    const bots = ["bot_1", "bot_2", "bot_3"];
    const pick1 = selectBotToken(bots);
    const pick2 = selectBotToken(bots);
    const pick3 = selectBotToken(bots);
    const pick4 = selectBotToken(bots);

    expect(pick1?.token).toBe("bot_1");
    expect(pick2?.token).toBe("bot_2");
    expect(pick3?.token).toBe("bot_3");
    expect(pick4?.token).toBe("bot_1");
  });
});
