const AWS = require('aws-sdk');
require('dotenv').config();

class AWSConfig {
  constructor() {
    AWS.config.update({
      region: process.env.AWS_REGION || 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    });

    this.s3 = new AWS.S3({
      apiVersion: '2006-03-01',
      // Configure for Glacier Instant Retrieval
      params: {
        Bucket: process.env.S3_BUCKET
      }
    });

    this.athena = new AWS.Athena({
      apiVersion: '2017-05-18'
    });
  }

  getS3() {
    return this.s3;
  }

  getAthena() {
    return this.athena;
  }

  getBucketName() {
    return process.env.S3_BUCKET;
  }

  getArchivePrefix() {
    return process.env.S3_ARCHIVE_PREFIX;
  }
}

module.exports = new AWSConfig();
