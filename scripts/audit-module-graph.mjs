// A static export ships the client bundle; the Node graph renders HTML at build time.
export function publishedWebModules(graphs, output) {
  if (output !== 'static') throw new Error('Modo de export web não calculável.');
  const modules = new Set();
  for (const graph of graphs) {
    if (
      graph.platform !== 'web' ||
      !['client', 'node'].includes(graph.environment) ||
      !Array.isArray(graph.modules) ||
      !graph.modules.length ||
      graph.modules.some((path) => typeof path !== 'string' || !path)
    )
      throw new Error('Grafo Metro inválido.');
    if (graph.environment === 'client') for (const path of graph.modules) modules.add(path);
  }
  if (!modules.size) throw new Error('Grafo publicado vazio.');
  return modules;
}
