/** Custom tools: the agent requests them, your process runs them. */

export type ToolFn = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export type Tool = {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments; top-level type must be "object". */
  inputSchema: Record<string, unknown>;
  fn: ToolFn;
};

/** Validate and return a custom tool definition. */
export function tool(spec: Tool): Tool {
  if (!spec.name) {
    throw new Error("Tool needs a non-empty name.");
  }
  if (!spec.description) {
    throw new Error(`Tool '${spec.name}' needs a description: add a docstring or pass description=.`);
  }
  return spec;
}

/** Validate a tool list, rejecting duplicate names. */
export function asTools(tools: readonly Tool[]): Tool[] {
  const names = tools.map((t) => t.name);
  const duplicates = [...new Set(names.filter((name, i) => names.indexOf(name) !== i))].sort();
  if (duplicates.length > 0) {
    // Python's `sorted(duplicates)` prints as a list repr: ['a', 'b'].
    throw new Error(`Duplicate tool names: [${duplicates.map((name) => `'${name}'`).join(", ")}].`);
  }
  return tools.map(tool);
}

/** The wire-format `ToolDefinition` carried by the `agent.tools` override. */
export function toolDefinition(t: Tool): Record<string, unknown> {
  return { name: t.name, description: t.description, input_schema: t.inputSchema };
}
