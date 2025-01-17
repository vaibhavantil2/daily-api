import 'reflect-metadata';
import fastify from 'fastify';
import { FastifyInstance, FastifyRequest } from 'fastify';
import helmet from 'fastify-helmet';
import cookie from 'fastify-cookie';
import cors from 'fastify-cors';
import { ExecutionParams } from 'subscriptions-transport-ws';

import './config';
import './profiler';

import trace from './trace';
import auth from './auth';
import compatibility from './compatibility';
import routes from './routes';

import { Context } from './Context';
import createApolloServer from './apollo';
import { createOrGetConnection } from './db';
import { stringifyHealthCheck } from './common';

type ContextParams = { request: FastifyRequest; connection: ExecutionParams };

export default async function app(): Promise<FastifyInstance> {
  const isProd = process.env.NODE_ENV === 'production';
  const connection = await createOrGetConnection();

  const app = fastify({
    logger: true,
    disableRequestLogging: true,
    trustProxy: isProd,
  });

  app.register(helmet);
  app.register(cors, {
    origin: process.env.NODE_ENV === 'production' ? /daily\.dev$/ : true,
    credentials: true,
  });
  app.register(cookie, { secret: process.env.COOKIES_KEY });
  app.register(trace, { enabled: isProd });
  app.register(auth, { secret: process.env.ACCESS_SECRET });

  app.setErrorHandler((err, req, res) => {
    req.log.error({ err }, err.message);
    res.code(500).send({ statusCode: 500, error: 'Internal Server Error' });
  });

  app.get('/health', (req, res) => {
    res.type('application/health+json');
    res.send(stringifyHealthCheck({ status: 'ok' }));
  });

  const server = await createApolloServer({
    context: ({
      request,
      connection: wsConnection,
    }: ContextParams): Context => {
      return new Context(request ?? wsConnection?.context?.req, connection);
    },
    playground: isProd
      ? false
      : { settings: { 'request.credentials': 'include' } },
    logger: app.log,
  });
  app.register(server.createHandler({ disableHealthCheck: true, cors: false }));
  if (process.env.ENABLE_SUBSCRIPTIONS === 'true') {
    server.installSubscriptionHandlers(app.server);
  }

  app.register(compatibility, { prefix: '/v1' });
  app.register(routes, { prefix: '/' });

  return app;
}
