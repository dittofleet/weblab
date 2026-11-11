// The parts of Playwright's internals weblab reaches for, which it ships without types.
declare module "playwright-core/lib/coreBundle" {
  export const registry: { registry: { findExecutable(name: string): { directory: string; downloadURLs: string[]; executablePath(): string } } };
  export const utils: { extractZip(zipPath: string, options: { dir: string }): Promise<void> };
}
