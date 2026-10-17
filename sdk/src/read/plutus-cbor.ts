// sdk/src/read/plutus-cbor.ts
// Plutus data CBOR decoder with no Lucid/CML dependency, for the browser's
// light read path. Reads everything the SDK's encoder (Lucid Data.to) writes:
// definite and indefinite lists, chunked bytes, bignums, constructor tags.
import { fromHex, toHex } from "../core/bytes.js";

export type PData =
  | { k: "constr"; index: number; fields: PData[] }
  | { k: "int"; v: bigint }
  | { k: "bytes"; hex: string }
  | { k: "list"; items: PData[] }
  | { k: "map"; entries: [PData, PData][] };

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}
  byte(): number {
    if (this.pos >= this.buf.length) throw new Error("plutus data: unexpected end of input");
    return this.buf[this.pos++]!;
  }
  take(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error("plutus data: unexpected end of input");
    return this.buf.slice(this.pos, (this.pos += n));
  }
  peek(): number {
    if (this.pos >= this.buf.length) throw new Error("plutus data: unexpected end of input");
    return this.buf[this.pos]!;
  }
}

/** Returns [major type, argument]; argument is null for an indefinite length. */
function head(r: Reader): [number, bigint | null] {
  const b = r.byte();
  const major = b >> 5;
  const ai = b & 31;
  if (ai < 24) return [major, BigInt(ai)];
  const width = { 24: 1, 25: 2, 26: 4, 27: 8 }[ai];
  if (width) return [major, BigInt("0x" + toHex(r.take(width)))];
  if (ai === 31 && major >= 2 && major <= 5) return [major, null];
  throw new Error(`plutus data: bad CBOR head 0x${b.toString(16)}`);
}

const BREAK = 0xff;

function items(r: Reader, n: bigint | null, read: () => void) {
  if (n === null) while (r.peek() !== BREAK) read();
  else for (let i = 0n; i < n; i++) read();
  if (n === null) r.byte(); // the break
}

function item(r: Reader): PData {
  const [major, arg] = head(r);
  switch (major) {
    case 0:
      return { k: "int", v: arg! };
    case 1:
      return { k: "int", v: -1n - arg! };
    case 2: {
      if (arg !== null) return { k: "bytes", hex: toHex(r.take(Number(arg))) };
      let hex = "";
      items(r, null, () => {
        const [m, n] = head(r);
        if (m !== 2 || n === null) throw new Error("plutus data: bad bytes chunk");
        hex += toHex(r.take(Number(n)));
      });
      return { k: "bytes", hex };
    }
    case 4: {
      const out: PData[] = [];
      items(r, arg, () => out.push(item(r)));
      return { k: "list", items: out };
    }
    case 5: {
      const out: [PData, PData][] = [];
      items(r, arg, () => out.push([item(r), item(r)]));
      return { k: "map", entries: out };
    }
    case 6: {
      const tag = Number(arg);
      if (tag === 2 || tag === 3) {
        const b = item(r);
        if (b.k !== "bytes") throw new Error("plutus data: bad bignum");
        const n = b.hex ? BigInt("0x" + b.hex) : 0n;
        return { k: "int", v: tag === 2 ? n : -1n - n };
      }
      let index: number;
      let fields: PData;
      if (tag >= 121 && tag <= 127) [index, fields] = [tag - 121, item(r)];
      else if (tag >= 1280 && tag <= 1400) [index, fields] = [tag - 1280 + 7, item(r)];
      else if (tag === 102) {
        const pair = item(r);
        if (pair.k !== "list" || pair.items.length !== 2 || pair.items[0]!.k !== "int") throw new Error("plutus data: bad tag 102");
        [index, fields] = [Number((pair.items[0] as { v: bigint }).v), pair.items[1]!];
      } else throw new Error(`plutus data: unknown tag ${tag}`);
      if (fields.k !== "list") throw new Error("plutus data: constructor fields must be a list");
      return { k: "constr", index, fields: fields.items };
    }
    default:
      throw new Error(`plutus data: unsupported CBOR major type ${major}`);
  }
}

export function decodePlutusData(hex: string): PData {
  const r = new Reader(fromHex(hex));
  const d = item(r);
  if (r.pos !== r.buf.length) throw new Error("plutus data: trailing bytes");
  return d;
}

export function asConstr(d: PData, index?: number, arity?: number): PData[] {
  if (d.k !== "constr") throw new Error("expected a constructor");
  if (index !== undefined && d.index !== index) throw new Error(`expected constructor ${index}, got ${d.index}`);
  if (arity !== undefined && d.fields.length !== arity) throw new Error(`expected ${arity} fields, got ${d.fields.length}`);
  return d.fields;
}
export function asInt(d: PData): bigint {
  if (d.k !== "int") throw new Error("expected an integer");
  return d.v;
}
export function asBytes(d: PData): string {
  if (d.k !== "bytes") throw new Error("expected bytes");
  return d.hex;
}
export function asList(d: PData): PData[] {
  if (d.k !== "list") throw new Error("expected a list");
  return d.items;
}

function encHead(major: number, n: bigint): string {
  const m = major << 5;
  if (n < 24n) return (m | Number(n)).toString(16).padStart(2, "0");
  for (const [ai, width] of [[24, 1], [25, 2], [26, 4], [27, 8]] as const)
    if (n < 1n << BigInt(8 * width)) return (m | ai).toString(16).padStart(2, "0") + n.toString(16).padStart(2 * width, "0");
  throw new Error("plutus data: length too large");
}

function encBytes(hex: string): string {
  // Plutus caps a bytes chunk at 64 bytes: longer strings go as an indefinite sequence of chunks.
  if (hex.length <= 128) return encHead(2, BigInt(hex.length / 2)) + hex;
  let out = "5f";
  for (let i = 0; i < hex.length; i += 128) out += encHead(2, BigInt(Math.min(128, hex.length - i) / 2)) + hex.slice(i, i + 128);
  return out + "ff";
}

/** Plutus data back to CBOR hex (definite lengths): for handing a datum's piece on, e.g. an app's settings. */
export function encodePlutusData(d: PData): string {
  switch (d.k) {
    case "int": {
      if (d.v >= 0n && d.v < 1n << 64n) return encHead(0, d.v);
      if (d.v < 0n && -1n - d.v < 1n << 64n) return encHead(1, -1n - d.v);
      const n = d.v >= 0n ? d.v : -1n - d.v;
      let hex = n.toString(16);
      if (hex.length % 2) hex = "0" + hex;
      return (d.v >= 0n ? "c2" : "c3") + encBytes(hex);
    }
    case "bytes":
      return encBytes(d.hex);
    case "list":
      return encHead(4, BigInt(d.items.length)) + d.items.map(encodePlutusData).join("");
    case "map":
      return encHead(5, BigInt(d.entries.length)) + d.entries.map(([k, v]) => encodePlutusData(k) + encodePlutusData(v)).join("");
    case "constr": {
      const fields = encHead(4, BigInt(d.fields.length)) + d.fields.map(encodePlutusData).join("");
      if (d.index < 7) return encHead(6, BigInt(121 + d.index)) + fields;
      if (d.index < 128) return encHead(6, BigInt(1280 + d.index - 7)) + fields;
      return encHead(6, 102n) + "82" + encHead(0, BigInt(d.index)) + fields;
    }
  }
}
