// MCP uses stdout for JSON-RPC. Executor logs must go to stderr.
console.log = (...args) => {
  console.error(...args);
};
