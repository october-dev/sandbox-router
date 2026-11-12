import { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import { sql } from 'drizzle-orm';
import { authenticate } from './auth.ts';
import type { App, AppEnv, Auth, ServerDeps } from './context.ts';
import { handleError } from './errors.ts';
import { registerApiKeyRoutes } from './routes/api-keys.ts';
import { registerProviderRoutes } from './routes/providers.ts';
import { registerSandboxRoutes } from './routes/sandboxes.ts';

export interface CreateAppOptions extends ServerDeps {
  /**
   * Registers extra routes, such as Cloud's balance and billing endpoints. They
   * share the app's authentication, error handling and OpenAPI document.
   */
  routes?: (app: App, auth: Auth) => void;
}

/** The `/v1` HTTP API: sandboxes, providers and API keys. */
export function createApp(options: CreateAppOptions): App {
  const app: App = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const message = result.error.issues
          .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
          .join('; ');
        return c.json({ error: { code: 'bad_request', message } }, 400);
      }
    },
  });

  app.onError(handleError);
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404));

  app.openAPIRegistry.registerComponent('securitySchemes', 'Bearer', {
    type: 'http',
    scheme: 'bearer',
    description: 'An API key: `Authorization: Bearer sr_...`',
  });

  const auth = authenticate(options);
  registerSandboxRoutes(app, options, auth);
  registerProviderRoutes(app, options);
  registerApiKeyRoutes(app, options, auth);
  options.routes?.(app, auth);

  app.get('/healthz', async (c) => {
    await options.db.execute(sql`select 1`);
    return c.json({ ok: true });
  });

  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Sandbox Router API',
      version: '1.0.0',
      description:
        'One API for cloud sandboxes on E2B and Daytona. Create a sandbox with a size and a preset ' +
        '(`cheap` or `fast`) and Sandbox Router places it on the best provider, at the provider\'s list price.',
    },
  });
  app.get('/docs', Scalar({ url: '/openapi.json', pageTitle: 'Sandbox Router API' }));
  app.get('/', (c) => c.redirect('/docs'));

  return app;
}
