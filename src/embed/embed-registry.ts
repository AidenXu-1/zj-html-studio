import type { App, Component, TFile } from "obsidian";
import type HtmlStudioPlugin from "../main";
import type { EmbedSessionLimiter } from "./embed-session-limiter";
import { HtmlEmbed, type HtmlEmbedContext } from "./html-embed";

interface EmbedRegistry {
  registerExtension(extension: string, factory: (context: HtmlEmbedContext, file: TFile) => Component): void;
  unregisterExtension(extension: string): void;
}

interface AppWithEmbedRegistry extends App {
  embedRegistry?: EmbedRegistry;
}

export function registerHtmlEmbedExtensions(
  plugin: HtmlStudioPlugin,
  limiter: EmbedSessionLimiter
): boolean {
  const registry = (plugin.app as AppWithEmbedRegistry).embedRegistry;
  if (!registry) return false;
  const registered: string[] = [];
  try {
    for (const extension of ["html", "htm"]) {
      registry.registerExtension(extension, (context, file) => new HtmlEmbed(plugin, context, file, limiter));
      registered.push(extension);
    }
  } catch (error) {
    registered.forEach(extension => registry.unregisterExtension(extension));
    throw error;
  }
  plugin.register(() => registered.forEach(extension => registry.unregisterExtension(extension)));
  return true;
}
