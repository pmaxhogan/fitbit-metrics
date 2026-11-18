declare module "cloudflare:test" {
  // Declaration merging: the empty extends is the point.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends Env {}
}
