import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerAllTools, TOOL_COUNT } from '../../src/register-tools.js';
import { harness, type Harness } from '../helpers/mcp-harness.js';
import { TOOL_ARGS, SEND_TOOLS, READ_TOOLS, writeToolNames } from '../helpers/tool-fixtures.js';

/**
 * What the server presents to an agent.
 *
 * The shape snapshot at the end is the single most valuable regression net an
 * MCP server can have: a tool's input schema is its contract with every agent
 * that has ever been told how to call it, and changing one is silent — nothing
 * fails, agents just start getting it wrong.
 */
describe('tool registration', () => {
  let h: Harness;
  let tools: Awaited<ReturnType<Harness['listTools']>>;

  beforeAll(async () => {
    h = await harness(registerAllTools);
    tools = await h.listTools();
  });

  afterAll(async () => {
    await h.close();
  });

  it(`registers exactly ${TOOL_COUNT} tools`, () => {
    // TOOL_COUNT feeds the startup banner. Asserting it here is what stops the
    // banner quietly lying after someone adds a tool.
    expect(tools).toHaveLength(TOOL_COUNT);
  });

  it('registers no duplicate names', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has a fixture for every registered tool, and no fixtures for tools that do not exist', () => {
    // Keeps the table-driven sweeps honest: without this, a new tool would be
    // absent from every sweep and nobody would notice.
    expect(Object.keys(TOOL_ARGS).sort()).toEqual(tools.map((t) => t.name).sort());
  });

  it('classifies every tool as either read or write', () => {
    const classified = [...READ_TOOLS, ...writeToolNames()].sort();
    expect(classified).toEqual(tools.map((t) => t.name).sort());
  });

  it('gives every tool a non-empty description', () => {
    const missing = tools.filter((t) => !t.description || t.description.trim().length === 0);
    expect(missing.map((t) => t.name)).toEqual([]);
  });

  it('marks every write tool as such in its description', () => {
    // An agent decides whether it needs `confirm` from the description alone.
    const unmarked = writeToolNames().filter((name) => {
      const tool = tools.find((t) => t.name === name);
      return !tool?.description?.includes('WRITE TOOL');
    });
    expect(unmarked).toEqual([]);
  });

  it('warns about outbound email in every send tool description', () => {
    for (const name of SEND_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} is not registered`).toBeDefined();
      expect(tool!.description, `${name} must warn that it emails the customer`).toMatch(
        /REAL EMAIL|REAL DUNNING EMAIL|REAL EMAIL TO THE CUSTOMER|ARMS A REAL EMAIL/i,
      );
      expect(tool!.description, `${name} must name the WEFACT_ALLOW_SEND gate`).toContain('WEFACT_ALLOW_SEND');
    }
  });

  it('exposes `administration` as an optional string wherever it appears', () => {
    for (const tool of tools) {
      const props = (tool.inputSchema['properties'] ?? {}) as Record<string, { type?: string }>;
      if (!props['administration']) continue;
      expect(props['administration'].type, `${tool.name}.administration`).toBe('string');
      const required = (tool.inputSchema['required'] ?? []) as string[];
      expect(required, `${tool.name}.administration must be optional`).not.toContain('administration');
    }
  });

  it('describes every input property', () => {
    // A property without a description is invisible to an agent — it will
    // either be ignored or guessed at.
    const undescribed: string[] = [];
    for (const tool of tools) {
      const props = (tool.inputSchema['properties'] ?? {}) as Record<string, { description?: string }>;
      for (const [prop, schema] of Object.entries(props)) {
        if (!schema.description || schema.description.trim().length === 0) {
          undescribed.push(`${tool.name}.${prop}`);
        }
      }
    }
    expect(undescribed).toEqual([]);
  });

  it('matches the published input-schema shape', () => {
    // Shape only — names, required-ness, types and enums. Descriptions are
    // deliberately excluded: they change with every prose tweak, and a snapshot
    // that churns on wording trains everyone to run `-u` without reading the
    // diff, which defeats the point.
    const shape = tools
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => {
        const props = (tool.inputSchema['properties'] ?? {}) as Record<
          string,
          { type?: string; enum?: unknown[]; anyOf?: unknown[] }
        >;
        return {
          name: tool.name,
          required: ((tool.inputSchema['required'] ?? []) as string[]).slice().sort(),
          properties: Object.entries(props)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([prop, schema]) => ({
              prop,
              type: schema.type ?? (schema.anyOf ? 'anyOf' : undefined),
              ...(schema.enum ? { enum: schema.enum } : {}),
            })),
        };
      });

    expect(shape).toMatchSnapshot();
  });
});
