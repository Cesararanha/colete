const { getDefaultConfig } = require('expo/metro-config');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const config = getDefaultConfig(__dirname);
// Cross-check only during this collector's export; no dev/rebuild snapshots.
if (process.env.COLETE_AUDIT_EXPORT_ID) {
  const previous = config.serializer.experimentalSerializerHook;
  let snapshot = 0;
  config.serializer.experimentalSerializerHook = (graph, delta) => {
    previous?.(graph, delta);
    const directory = join(__dirname, '.expo/audit-graphs');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `${process.pid}-${snapshot++}.json`),
      JSON.stringify({
        exportId: process.env.COLETE_AUDIT_EXPORT_ID,
        platform: graph.transformOptions.platform,
        environment: graph.transformOptions.customTransformOptions?.environment ?? 'client',
        modules: [...graph.dependencies.keys()],
      }),
    );
  };
}
module.exports = config;
