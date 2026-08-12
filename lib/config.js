var config = {
  port: parseInt(process.env.PORT, 10) || 3003,
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  sesConfigurationSet: process.env.SES_CONFIGURATION_SET || 'ghost-ses-proxy',
  sqsQueueUrl: process.env.SQS_QUEUE_URL,
  proxyApiKey: process.env.PROXY_API_KEY,
  mailgunDomain: process.env.MAILGUN_DOMAIN,
  logLevel: process.env.LOG_LEVEL || 'info',
  // Higher default: background batch delivery no longer blocks Ghost's 60s
  // HTTP timeout, so we can push SES harder without causing retries.
  sendConcurrency: parseInt(process.env.SEND_CONCURRENCY, 10) || 25
};

var required = [
  ['AWS_ACCESS_KEY_ID', config.awsAccessKeyId],
  ['AWS_SECRET_ACCESS_KEY', config.awsSecretAccessKey],
  ['SQS_QUEUE_URL', config.sqsQueueUrl],
  ['PROXY_API_KEY', config.proxyApiKey],
  ['MAILGUN_DOMAIN', config.mailgunDomain]
];

var missing = required.filter(function(pair) { return !pair[1]; });
if (missing.length > 0) {
  console.error('Missing required environment variables: ' + missing.map(function(p) { return p[0]; }).join(', '));
  process.exit(1);
}

module.exports = config;
