import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';

/**
 * Proxy da API do Claude para o gerador de roteiros (dev e preview).
 * A chave vem de ANTHROPIC_API_KEY (.env.local ou variável de ambiente) e é
 * adicionada aqui, no servidor — nunca é enviada ao navegador nem ao bundle.
 */
function anthropicProxy(apiKey: string | undefined): Record<string, ProxyOptions> {
  if (!apiKey) return {};
  return {
    '/api/anthropic': {
      target: 'https://api.anthropic.com',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api\/anthropic/, ''),
      configure: (proxy) => {
        proxy.on('proxyReq', (req) => {
          req.setHeader('x-api-key', apiKey);
          req.removeHeader('authorization');
          req.removeHeader('cookie');
        });
      },
    },
  };
}

/** GET /api/polytale/ai-status -> { available } (o app decide entre proxy e chave própria). */
function aiStatus(available: boolean): Plugin {
  const handler = (_req: unknown, res: { setHeader(k: string, v: string): void; end(body: string): void }) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ available }));
  };
  return {
    name: 'polytale-ai-status',
    configureServer(server) {
      server.middlewares.use('/api/polytale/ai-status', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/polytale/ai-status', handler);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const apiKey = env.ANTHROPIC_API_KEY || undefined;
  const proxy = anthropicProxy(apiKey);

  return {
    base: './',
    plugins: [aiStatus(!!apiKey)],
    server: {
      port: 5173,
      open: false,
      proxy,
    },
    preview: {
      proxy,
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          manualChunks: {
            three: ['three'],
          },
        },
      },
    },
  };
});
