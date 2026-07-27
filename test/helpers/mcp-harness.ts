import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { WeFactClient } from '../../src/wefact-client.js';
import { RecordingClient } from './recording-client.js';

/**
 * Drives the tool layer through a **real** `McpServer` and a real MCP `Client`
 * over a linked in-memory transport pair.
 *
 * A cheaper fake that just captured `registerTool` calls and invoked handlers
 * directly would miss the thing most worth testing: the SDK validates tool
 * arguments with zod **server-side** before a handler runs. One of the
 * behaviours this suite locks — the `CostCategory` number→string coercion —
 * lives entirely inside a zod `.transform`, so with a capture-fake that
 * transform could be deleted and every test would stay green.
 *
 * Going through the real server also exercises tool-definition validation,
 * duplicate-name detection and result serialisation for free, at roughly a
 * millisecond per call.
 */

type Register = (server: McpServer, client: WeFactClient) => void;

export interface ToolCall {
  /** Raw text of the first content block. */
  text: string;
  /**
   * Parsed body, or `undefined` when the SDK rejected the arguments — a
   * validation failure resolves with `isError: true` and a plain-text message
   * ("MCP error -32602: Input validation error: …"), not JSON.
   */
  body: Record<string, unknown> | undefined;
  isError: boolean;
}

export interface Harness {
  /** The inert client the tools were registered against. */
  wefact: RecordingClient;
  call(name: string, args?: Record<string, unknown>): Promise<ToolCall>;
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>>;
  toolNames(): Promise<string[]>;
  close(): Promise<void>;
}

export async function harness(
  register: Register | Register[],
  wefact: RecordingClient = new RecordingClient(),
): Promise<Harness> {
  const server = new McpServer({ name: 'wefact-mcp-test', version: '0.0.0' });
  for (const r of Array.isArray(register) ? register : [register]) r(server, wefact);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([mcp.connect(clientTransport), server.connect(serverTransport)]);

  return {
    wefact,

    async call(name, args = {}) {
      const result = await mcp.callTool({ name, arguments: args });
      const content = (result['content'] ?? []) as Array<{ type: string; text?: string }>;
      const first = content[0];
      const text = first && first.type === 'text' ? (first.text ?? '') : '';
      let body: Record<string, unknown> | undefined;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = undefined;
      }
      return { text, body, isError: result['isError'] === true };
    },

    async listTools() {
      const { tools } = await mcp.listTools();
      return tools as Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
    },

    async toolNames() {
      const { tools } = await mcp.listTools();
      return tools.map((t) => t.name).sort();
    },

    async close() {
      await mcp.close();
    },
  };
}
