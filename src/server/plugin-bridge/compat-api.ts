/**
 * OpenClaw Plugin API Compatibility Shim
 *
 * Provides the `OpenClawPluginApi` interface that plugins call during registration.
 * Captures the registered channel plugin and tool definitions for the bridge to use.
 */

export interface CapturedTool {
  factory: (ctx: Record<string, unknown>) => Record<string, unknown> | Record<string, unknown>[] | null;
  name: string;
  pluginId: string;
  optional: boolean;
}

export interface CapturedCommand {
  name: string;
  description: string;
  execute: (ctx: Record<string, unknown>) => Promise<string | Record<string, unknown>>;
}

export interface CapturedPlugin {
  id: string;
  name: string;
  /** The raw channel plugin object (for config resolution, gateway, etc.) */
  raw: Record<string, unknown>;
  gateway: Record<string, unknown>;
  sendText?: (chatId: string, text: string) => Promise<{ messageId?: string } | void>;
  editMessage?: (chatId: string, messageId: string, text: string) => Promise<void>;
  deleteMessage?: (chatId: string, messageId: string) => Promise<void>;
  sendMedia?: (params: Record<string, unknown>) => Promise<{ messageId?: string } | void>;
}

/**
 * OpenClaw plugins receive MyAgents' logger and may emit a debug line for
 * every full-snapshot partial callback. Those callbacks are transport detail:
 * pending-dispatch already owns terminal counts and canonical final logging.
 * Keep the rule protocol-shaped (callback name), never plugin-id-shaped.
 */
export function shouldSuppressPluginDebugLog(args: readonly unknown[]): boolean {
  return args.some(arg => typeof arg === 'string' && /\bonPartialReply\b/.test(arg));
}

/**
 * Create an OpenClaw-compatible API object for plugin registration.
 */
export function createCompatApi(config: Record<string, unknown>) {
  let capturedPlugin: CapturedPlugin | null = null;
  const capturedTools: CapturedTool[] = [];
  const capturedCommands: CapturedCommand[] = [];

  const api = {
    /**
     * Called by the plugin to register a channel.
     * Plugins may call: api.registerChannel(channelPlugin) or api.registerChannel({ plugin: channelPlugin })
     */
    registerChannel(arg: Record<string, unknown>) {
      // Unwrap { plugin: ... } wrapper if present
      const plugin = (arg.plugin && typeof arg.plugin === 'object')
        ? (arg.plugin as Record<string, unknown>)
        : arg;
      const id = String(plugin.id || 'unknown');
      const meta = plugin.meta as Record<string, unknown> | undefined;
      const name = String(plugin.name || meta?.label || plugin.id || 'Unknown Plugin');
      const gateway = (plugin.gateway || {}) as Record<string, unknown>;
      const sendText = typeof plugin.sendText === 'function'
        ? (plugin.sendText as CapturedPlugin['sendText']) : undefined;
      const editMessage = typeof plugin.editMessage === 'function'
        ? (plugin.editMessage as CapturedPlugin['editMessage']) : undefined;
      const deleteMessage = typeof plugin.deleteMessage === 'function'
        ? (plugin.deleteMessage as CapturedPlugin['deleteMessage']) : undefined;
      const sendMedia = typeof plugin.sendMedia === 'function'
        ? (plugin.sendMedia as CapturedPlugin['sendMedia']) : undefined;

      capturedPlugin = { id, name, raw: plugin, gateway, sendText, editMessage, deleteMessage, sendMedia };
      console.log(`[compat-api] Channel registered: ${capturedPlugin.id}`);
    },

    /**
     * Plugin config — pass through from MyAgents config.
     */
    config,

    /**
     * Logger — map to console.
     */
    logger: {
      info: (...args: unknown[]) => console.log('[plugin]', ...args),
      warn: (...args: unknown[]) => console.warn('[plugin]', ...args),
      error: (...args: unknown[]) => console.error('[plugin]', ...args),
      debug: (...args: unknown[]) => {
        if (!shouldSuppressPluginDebugLog(args)) console.debug('[plugin]', ...args);
      },
    },

    /**
     * Plugin runtime — set by the bridge before calling register().
     * Plugins call api.runtime to access channel runtime APIs.
     */
    runtime: null as unknown,

    // Other OpenClaw API methods — capture tools, no-op stubs for the rest.
    // Plugins may call any of these during register(); must not throw.

    /**
     * Called by plugins to register tools.
     * Accepts either:
     *   - A factory function: (ctx) => tool | tool[]
     *   - A direct tool object: { name, description, parameters, execute }
     * Second arg (opts) may contain { name, optional }.
     */
    registerTool(
      factoryOrTool: ((ctx: Record<string, unknown>) => Record<string, unknown> | Record<string, unknown>[] | null) | Record<string, unknown>,
      opts?: Record<string, unknown>,
    ) {
      let factory: CapturedTool['factory'];
      let toolName: string;

      if (typeof factoryOrTool === 'function') {
        // Factory function pattern: registerTool((ctx) => tool, { name })
        factory = factoryOrTool as CapturedTool['factory'];
        toolName = String(opts?.name || 'unknown');
      } else {
        // Direct tool object pattern: registerTool({ name, description, parameters, execute })
        const toolObj = factoryOrTool;
        toolName = String(opts?.name || toolObj.name || 'unknown');
        factory = () => toolObj;
      }

      const pluginId = capturedPlugin?.id || 'unknown';
      const optional = opts?.optional === true;

      capturedTools.push({ factory, name: toolName, pluginId, optional });
      console.log(`[compat-api] Tool registered: ${toolName} (plugin=${pluginId}, optional=${optional})`);
    },

    registerAgent() {},
    registerSkill() {},
    registerHook() {},
    registerCli() {},
    registerAction() {},
    registerProvider() {},
    registerHttpRoute(_route: Record<string, unknown>) {
      // No-op in Bridge mode — MyAgents doesn't run OpenClaw's HTTP server.
      // Plugins register webhook routes here; silently ignore.
    },

    // Event emitter API — plugins register lifecycle hooks via api.on()
    on(_event: string, _handler: (...args: unknown[]) => void) {},
    off(_event: string, _handler: (...args: unknown[]) => void) {},
    emit(_event: string, ..._args: unknown[]) {},

    // Command registration — capture for Rust IM layer routing
    registerCommand(cmd: Record<string, unknown>) {
      const name = String(cmd.name || cmd.command || '').trim().replace(/^\//, '');
      if (!name || /\s/.test(name)) return; // Reject empty or whitespace-containing names
      const description = String(cmd.description || cmd.help || '');
      const handler = (cmd.handler || cmd.execute) as CapturedCommand['execute'] | undefined;
      if (typeof handler === 'function') {
        capturedCommands.push({ name, description, execute: handler });
        console.log(`[compat-api] Command registered: /${name}`);
      }
    },
    registerChatCommand(cmd: Record<string, unknown>) {
      // Alias — same as registerCommand
      api.registerCommand(cmd);
    },

    // MCP tool registration — no-op (Bridge uses its own MCP proxy)
    registerMcpServer(_server: unknown) {},

    // Catch-all for any other API methods plugins might call
    [Symbol.for('bridge-compat')]: true,

    /**
     * Get the captured plugin after registration.
     */
    getCapturedPlugin(): CapturedPlugin | null {
      return capturedPlugin;
    },

    /**
     * Get all captured tool definitions after registration.
     */
    getCapturedTools(): CapturedTool[] {
      return capturedTools;
    },

    /**
     * Get all captured command definitions after registration.
     */
    getCapturedCommands(): CapturedCommand[] {
      return capturedCommands;
    },
  };

  return api;
}
