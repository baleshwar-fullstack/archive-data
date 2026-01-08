const winston = require('winston');
const fs = require('fs');
const path = require('path');

class Logger {
  constructor() {
    // Determine if running in AWS Lambda
    this.isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
    this.logDir = this.isLambda ? '/tmp/logs' : 'logs';
    
    // Ensure log directory exists
    if (!this.isLambda && !fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { 
        service: 'tiered-data-storage',
        environment: process.env.NODE_ENV || 'development',
        isLambda: this.isLambda
      },
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        })
      ]
    });

    // Add file transports only in non-Lambda production environments
    if (process.env.NODE_ENV === 'production' && !this.isLambda) {
      this.logger.add(new winston.transports.File({ 
        filename: path.join(this.logDir, 'error.log'), 
        level: 'error' 
      }));
      this.logger.add(new winston.transports.File({ 
        filename: path.join(this.logDir, 'combined.log') 
      }));
    }
  }

  info(message, meta = {}) {
    this.logger.info(message, meta);
  }

  error(message, meta = {}) {
    this.logger.error(message, meta);
  }

  warn(message, meta = {}) {
    this.logger.warn(message, meta);
  }

  debug(message, meta = {}) {
    this.logger.debug(message, meta);
  }
}

module.exports = new Logger();
