// Do the sync + serverless NAPI/JS surfaces load under Bun at all?
const sync = await import("@tursodatabase/sync");
console.log("@tursodatabase/sync exports:", Object.keys(sync).join(", "));
const serverless = await import("@tursodatabase/serverless");
console.log("@tursodatabase/serverless exports:", Object.keys(serverless).join(", "));
