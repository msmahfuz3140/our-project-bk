import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';

class Database {
  private isConnecting = false;
  private memoryServer?: any;

  async connect(): Promise<boolean> {
    if (mongoose.connection.readyState === 1) {
      return true;
    }

    if (this.isConnecting) {
      return false;
    }

    this.isConnecting = true;

    try {
      mongoose.connection.on('connected', () => {
        logger.info('MongoDB connected successfully', { host: mongoose.connection.host });
      });

      mongoose.connection.on('error', (err) => {
        logger.error('MongoDB connection error', err);
      });

      mongoose.connection.on('disconnected', () => {
        logger.warn('MongoDB disconnected');
      });

      mongoose.connection.on('reconnected', () => {
        logger.info('MongoDB reconnected');
      });

      await mongoose.connect(env.MONGODB_URI, {
        serverSelectionTimeoutMS: env.NODE_ENV === 'production' ? 10000 : 3000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        maxPoolSize: 50,
        minPoolSize: env.NODE_ENV === 'production' ? 5 : 1,
        autoIndex: env.NODE_ENV !== 'production'
      });

      this.isConnecting = false;
      return true;
    } catch (error) {
      if (env.NODE_ENV === 'development') {
        try {
          // If a local or embedded engine is already running on 27017, connect directly
          await mongoose.connect('mongodb://127.0.0.1:27017/roulette-accuracy', {
            serverSelectionTimeoutMS: 2000
          });
          logger.info('Connected to active local MongoDB engine on 127.0.0.1:27017');
          this.isConnecting = false;
          return true;
        } catch {
          // Continue to spawn embedded engine
        }

        logger.warn('Standalone MongoDB not detected. Initializing embedded development engine (persisted in .dev-db)...');
        try {
          const fs = await import('fs');
          const path = await import('path');
          const { MongoMemoryServer } = await import('mongodb-memory-server');

          const dbDir = path.resolve(process.cwd(), '.dev-db');
          if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
          }

          this.memoryServer = await MongoMemoryServer.create({
            instance: {
              port: 27017,
              dbPath: dbDir,
              dbName: 'roulette-accuracy'
            }
          });

          const uri = this.memoryServer.getUri('roulette-accuracy');
          await mongoose.connect(uri);
          logger.info(`Development database engine is active and ready: ${uri}`);
          this.isConnecting = false;
          return true;
        } catch (memErr) {
          logger.error('Failed to initialize development MongoMemoryServer fallback', memErr);
        }
      }

      this.isConnecting = false;
      logger.error('Failed to connect to MongoDB initially. Will retry in background or on first request.', error);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
      logger.info('MongoDB connection closed gracefully');
    }
    if (this.memoryServer) {
      await this.memoryServer.stop();
      logger.info('Embedded development MongoMemoryServer stopped');
    }
  }

  getHealth(): { status: string; readyState: number; isConnected: boolean; host?: string; dbName?: string } {
    const readyState = mongoose.connection.readyState;
    const isConnected = readyState === 1;
    const states: Record<number, string> = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting'
    };

    return {
      status: states[readyState] || 'unknown',
      readyState,
      isConnected,
      host: mongoose.connection.host || undefined,
      dbName: mongoose.connection.name || undefined
    };
  }
}

export const db = new Database();
