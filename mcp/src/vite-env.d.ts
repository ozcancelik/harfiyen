// cuts.ts imports a type from the app's hooks, which reach src/models.ts and its Vite env; the types only.
interface ImportMeta {
  readonly env: Record<string, string>;
}
