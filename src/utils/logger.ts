type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

class Logger {
  private currentLevel(): number {
    const configured = (process.env.LOG_LEVEL || 'INFO').toUpperCase() as LogLevel;
    return LEVEL_SEVERITY[configured] !== undefined ? LEVEL_SEVERITY[configured] : 1;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_SEVERITY[level] >= this.currentLevel();
  }

  private formatMessage(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    const logObject = {
      timestamp,
      level,
      message,
      ...(meta && Object.keys(meta).length > 0 ? { meta } : {})
    };
    return JSON.stringify(logObject);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('INFO')) {
      console.log(this.formatMessage('INFO', message, meta));
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('WARN')) {
      console.warn(this.formatMessage('WARN', message, meta));
    }
  }

  error(message: string, error?: Error | unknown, meta?: Record<string, unknown>): void {
    if (this.shouldLog('ERROR')) {
      const errorDetails = error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : error;

      console.error(this.formatMessage('ERROR', message, {
        ...meta,
        error: errorDetails
      }));
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('DEBUG')) {
      console.debug(this.formatMessage('DEBUG', message, meta));
    }
  }
}

export const logger = new Logger();

