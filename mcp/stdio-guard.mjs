// MCP dùng stdout cho JSON-RPC. Mọi log của executor phải ra stderr.
console.log = (...args) => {
  console.error(...args);
};
