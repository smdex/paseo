import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createJcodeProvider } from "./server/provider.js";

export default function contribute(server: Pick<PluginServerContext, "registerProvider">) {
  server.registerProvider(createJcodeProvider());
  return () => {};
}
