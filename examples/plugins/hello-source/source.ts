// The smallest webhook plugin, for a made-up system that POSTs { "id", "kind", "order", "note" } and signs the body with
// HMAC-SHA256 in the x-shop-signature header. It only translates: it makes no requests, and it can't be async.
//   rules.json:  "sources": { "shop": { "name": "shop", "adapter": "hello-source" } }
//   secrets.env: AGENT_AUTOLOOP_SECRET_SHOP=…
// The address to give the other side is /v1/in/shop.
import { createHmac, timingSafeEqual } from "node:crypto";

type Input = {
  headers: Record<string, string | string[] | undefined>;
  body: string;
  secret: string;
  /** Refusing says "a stranger" (401); anything else thrown here reads as a payload the adapter couldn't read (400). */
  refuse: (why?: string) => never;
};

export default function helloSource({ headers, body, secret, refuse }: Input) {
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(String(headers["x-shop-signature"] ?? ""));
  if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) refuse();
  const { id, kind, order, note } = JSON.parse(body);
  if (kind === "ping") return [];
  return [
    { id: String(id), type: `order.${kind}`, subject: `order-${order}`, summary: String(note ?? "").slice(0, 200) },
  ];
}
