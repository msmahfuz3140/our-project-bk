import { app } from './app';
import { env } from './config/env';
import { db } from './database/connection';
import { initializeAuthoritativeAdmin } from './database/initAdmin';
import { logger } from './utils/logger';

async function bootstrap() {
  logger.info('Starting Roulette Platform API server...', {
    environment: env.NODE_ENV,
    port: env.PORT
  });

  // Connect to Database
  await db.connect();

  // Ensure authoritative SUPER_ADMIN exists in MongoDB and old demo accounts are removed
  await initializeAuthoritativeAdmin().catch((err) => {
    logger.error('Warning: could not complete admin initialization', err);
  });

  const server = app.listen(env.PORT, () => {
    logger.info(`Server is up and listening on port ${env.PORT}`, {
      apiUrl: `http://localhost:${env.PORT}/api/v1`,
      healthUrl: `http://localhost:${env.PORT}/health`
    });
  });

  // Graceful shutdown handling
  const handleShutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Initiating graceful shutdown...`);
    server.close(async () => {
      logger.info('HTTP server closed');
      await db.disconnect();
      process.exit(0);
    });

    // Force shutdown after 10 seconds if still hanging
    setTimeout(() => {
      logger.error('Forced shutdown due to timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.error('Fatal error during application bootstrap', err);
  process.exit(1);
});
