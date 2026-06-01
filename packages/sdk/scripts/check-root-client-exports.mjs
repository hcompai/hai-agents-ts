const mod = await import("../dist/index.js");

const expectedExports = {
  client: "object",
  createClient: "function",
  createConfig: "function",
};

const failures = [];
for (const [name, expectedType] of Object.entries(expectedExports)) {
  const actualType = typeof mod[name];
  if (actualType !== expectedType) {
    failures.push(`${name}: expected ${expectedType}, got ${actualType}`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Root client exports are available");
