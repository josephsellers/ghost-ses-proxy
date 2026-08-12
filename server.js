var express = require('express');
var config = require('./lib/config');
var authMiddleware = require('./lib/auth');
var { db } = require('./lib/db');
var handleSendEmail = require('./lib/send-email');
var handleGetEvents = require('./lib/events-api');
var handleDeleteSuppression = require('./lib/suppression-api');
var { startPolling } = require('./lib/sqs-poller');

var app = express();

// --- Health check (unauthenticated) ---
app.get('/health', function(req, res) {
  var messageMapCount = db.prepare('SELECT COUNT(*) as c FROM message_map').get().c;
  var recipientCount = db.prepare('SELECT COUNT(*) as c FROM recipient_emails').get().c;
  var claimCount = db.prepare('SELECT COUNT(*) as c FROM send_claims').get().c;
  var eventCount = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
  var suppressionCount = db.prepare('SELECT COUNT(*) as c FROM suppressions').get().c;

  res.json({
    status: 'ok',
    version: require('./package.json').version,
    tables: {
      message_map: messageMapCount,
      recipient_emails: recipientCount,
      send_claims: claimCount,
      events: eventCount,
      suppressions: suppressionCount
    }
  });
});

// --- Auth middleware for /v3 prefix ---
app.use('/v3', authMiddleware);

// --- Email sending ---
app.post('/v3/:domain/messages', handleSendEmail);

// --- Events endpoint ---
app.get('/v3/:domain/events', handleGetEvents);
app.get('/v3/:domain/events/:pageToken', handleGetEvents);

// --- Suppression deletion ---
app.delete('/v3/:domain/:type/:email', handleDeleteSuppression);

// --- Start ---
app.listen(config.port, function() {
  console.log('ghost-ses-proxy listening on port ' + config.port);
  console.log('  Domain: ' + config.mailgunDomain);
  console.log('  Region: ' + config.awsRegion);
  console.log('  Configuration set: ' + config.sesConfigurationSet);
  console.log('  Send concurrency: ' + config.sendConcurrency);
  startPolling();
});
