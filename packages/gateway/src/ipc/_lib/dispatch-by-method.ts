export type RpcMissOrHit<V = unknown> =
  | { readonly kind: "hit"; readonly value: V }
  | { readonly kind: "miss" };

export type RpcMethodHandler<Ctx, V = unknown> = (params: unknown, ctx: Ctx) => Promise<V> | V;

export type RpcMethodHandlerMap<Ctx, V = unknown> = Readonly<
  Record<string, RpcMethodHandler<Ctx, V>>
>;

export async function dispatchByMethod<Ctx, V = unknown>(
  method: string,
  params: unknown,
  ctx: Ctx,
  handlers: RpcMethodHandlerMap<Ctx, V>,
): Promise<RpcMissOrHit<V>> {
  if (!Object.hasOwn(handlers, method)) {
    return { kind: "miss" };
  }
  const handler = handlers[method];
  if (handler === undefined) {
    return { kind: "miss" };
  }
  return { kind: "hit", value: await handler(params, ctx) };
}
