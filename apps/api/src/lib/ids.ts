import { randomInt } from "./random.js";

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function newPin(): string {
  return String(1000 + randomInt(9000));
}
